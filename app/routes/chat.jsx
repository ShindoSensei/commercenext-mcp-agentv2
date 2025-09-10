// app/routes/chat.jsx

/**
 * Chat API Route
 * Handles chat interactions with Claude API and tools
 */
import { json } from "@remix-run/node";
import MCPClient from "../mcp-client";
import {
  saveMessage,
  getConversationHistory,
  storeCustomerAccountUrl,
  getCustomerAccountUrl,
} from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createClaudeService } from "../services/claude.server";
import { createToolService } from "../services/tool.server";
import { unauthenticated } from "../shopify.server";

/**
 * ADDED: Resolve a valid myshopify.com domain for Shopify SDK calls.
 * Priority: ?shop param -> X-Shopify-Shop-Domain header -> env (MYSHOPIFY_DOMAIN).
 * This avoids InvalidShopError.
 */
function resolveShopDomain(request) {
  const url = new URL(request.url);

  let shop =
    url.searchParams.get("shop") ||
    request.headers.get("X-Shopify-Shop-Domain") ||
    process.env.MYSHOPIFY_DOMAIN; // e.g., adsmdemo.myshopify.com (set on Render)

  if (!shop) {
    throw new Error(
      "Missing shop domain (expected ?shop, X-Shopify-Shop-Domain, or MYSHOPIFY_DOMAIN)."
    );
  }

  // Accept URL or hostname; normalize to hostname
  if (shop.includes("://")) shop = new URL(shop).hostname;

  // Shopify libraries expect a myshopify.com domain
  if (!/\.myshopify\.com$/i.test(shop)) {
    throw new Error(`Invalid shop domain for Shopify SDK: ${shop}`);
  }

  return shop;
}

/**
 * Remix loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }

  const url = new URL(request.url);

  // Handle history fetch requests - matches /chat?history=true&conversation_id=XYZ
  if (url.searchParams.has("history") && url.searchParams.has("conversation_id")) {
    return handleHistoryRequest(request, url.searchParams.get("conversation_id"));
  }

  // Handle SSE requests
  if (!url.searchParams.has("history") && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  // API-only: reject all other requests
  return json(
    { error: AppConfig.errorMessages.apiUnsupported },
    { status: 400, headers: getCorsHeaders(request) }
  );
}

/**
 * Remix action function for handling POST requests
 */
export async function action({ request }) {
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);

  return json({ messages }, { headers: getCorsHeaders(request) });
}

/**
 * Handle chat requests (both GET and POST)
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();
    const userMessage = body.message;

    // Validate required message
    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Generate or use existing conversation ID
    const conversationId = body.conversation_id || Date.now().toString();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        stream,
      });
    });

    return new Response(responseStream, { headers: getSseHeaders(request) });
  } catch (error) {
    console.error("Error in chat request handler:", error);
    return json(
      { error: error.message },
      {
        status: 500,
        headers: getCorsHeaders(request),
      }
    );
  }
}

/**
 * Handle a complete chat session
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  stream,
}) {
  // Initialize services
  const claudeService = createClaudeService();
  const toolService = createToolService();

  // CHANGED: Use a valid myshopify.com domain, not request Origin.
  const shopDomain = resolveShopDomain(request);
  const shopId = request.headers.get("X-Shopify-Shop-Id") || "unknown";

  // CHANGED: Discover Customer Accounts MCP endpoint using the myshopify domain.
  const customerMcpEndpoint = await getCustomerMcpEndpoint(shopDomain, conversationId);

  // CHANGED: Initialize MCP client with myshopify.com shopDomain so /api/mcp hits a JSON endpoint.
  const mcpClient = new MCPClient(shopDomain, conversationId, shopId, customerMcpEndpoint);

  try {
    // Send conversation ID to client
    stream.sendMessage({ type: "id", conversation_id: conversationId });

    // Connect to MCP servers and get available tools
    let storefrontMcpTools = [],
      customerMcpTools = [];

    try {
      storefrontMcpTools = await mcpClient.connectToStorefrontServer();

      // Optional: gate customer MCP until OAuth is wired
      if (process.env.ENABLE_CUSTOMER_MCP === "true" && customerMcpEndpoint) {
        customerMcpTools = await mcpClient.connectToCustomerServer();
      }

      console.log(`Connected to MCP with ${storefrontMcpTools.length} tools`);
      if (customerMcpTools.length) {
        console.log(`Connected to customer MCP with ${customerMcpTools.length} tools`);
      }
    } catch (error) {
      console.warn("Failed to connect to MCP servers, continuing without tools:", error.message);
    }

    // Prepare conversation state
    let conversationHistory = [];
    let productsToDisplay = [];

    // Save user message to the database
    await saveMessage(conversationId, "user", userMessage);

    // Fetch all messages from the database for this conversation
    const dbMessages = await getConversationHistory(conversationId);

    // Format messages for Claude API
    conversationHistory = dbMessages.map((dbMessage) => {
      let content;
      try {
        content = JSON.parse(dbMessage.content);
      } catch (e) {
        content = dbMessage.content;
      }
      return {
        role: dbMessage.role,
        content,
      };
    });

    // Execute the conversation stream
    let finalMessage = { role: "user", content: userMessage };

    while (finalMessage.stop_reason !== "end_turn") {
      finalMessage = await claudeService.streamConversation(
        {
          messages: conversationHistory,
          promptType,
          tools: mcpClient.tools,
        },
        {
          // Handle text chunks
          onText: (textDelta) => {
            stream.sendMessage({
              type: "chunk",
              chunk: textDelta,
            });
          },

          // Handle complete messages
          onMessage: (message) => {
            conversationHistory.push({
              role: message.role,
              content: message.content,
            });

            saveMessage(conversationId, message.role, JSON.stringify(message.content)).catch(
              (error) => {
                console.error("Error saving message to database:", error);
              }
            );

            // Send a completion message
            stream.sendMessage({ type: "message_complete" });
          },

          // Handle tool use requests
          onToolUse: async (content) => {
            const toolName = content.name;
            const toolArgs = content.input;
            const toolUseId = content.id;

            const toolUseMessage = `Calling tool: ${toolName} with arguments: ${JSON.stringify(
              toolArgs
            )}`;

            stream.sendMessage({
              type: "tool_use",
              tool_use_message: toolUseMessage,
            });

            // Call the tool
            const toolUseResponse = await mcpClient.callTool(toolName, toolArgs);

            // Handle tool response based on success/error
            if (toolUseResponse.error) {
              await toolService.handleToolError(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                stream.sendMessage,
                conversationId
              );
            } else {
              await toolService.handleToolSuccess(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                productsToDisplay,
                conversationId
              );
            }

            // Signal new message to client
            stream.sendMessage({ type: "new_message" });
          },

          // Handle content block completion
          onContentBlock: (contentBlock) => {
            if (contentBlock.type === "text") {
              stream.sendMessage({
                type: "content_block_complete",
                content_block: contentBlock,
              });
            }
          },
        }
      );
    }

    // Signal end of turn
    stream.sendMessage({ type: "end_turn" });

    // Send product results if available
    if (productsToDisplay.length > 0) {
      stream.sendMessage({
        type: "product_results",
        products: productsToDisplay,
      });
    }
  } catch (error) {
    // The streaming handler takes care of error handling
    throw error;
  }
}

/**
 * Get the customer MCP endpoint for a shop
 */
async function getCustomerMcpEndpoint(shopDomain, conversationId) {
  try {
    // Check if the customer account URL exists in the DB
    const existingUrl = await getCustomerAccountUrl(conversationId);
    if (existingUrl) {
      return `${existingUrl.replace(/\/+$/, "")}/customer/api/mcp`;
    }

    // shopDomain is already a normalized myshopify.com hostname
    const { storefront } = await unauthenticated.storefront(shopDomain);

    const response = await storefront.graphql(
      `#graphql
      query shop {
        shop {
          customerAccountUrl
        }
      }`
    );

    const body = await response.json();
    const customerAccountUrl = body?.data?.shop?.customerAccountUrl;

    if (!customerAccountUrl) {
      throw new Error("customerAccountUrl not available (is Customer Accounts enabled?)");
    }

    // Store and return endpoint
    await storeCustomerAccountUrl(conversationId, customerAccountUrl);
    return `${customerAccountUrl.replace(/\/+$/, "")}/customer/api/mcp`;
  } catch (error) {
    console.error("Error getting customer MCP endpoint:", error);
    return null; // Continue without customer MCP
  }
}

/**
 * Gets CORS headers for the response
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders =
    request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400", // 24 hours
  };
}

/**
 * Get SSE headers for the response
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers":
      "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version",
  };
}
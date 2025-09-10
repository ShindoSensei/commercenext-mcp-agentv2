// app/mcp-client.js

import { generateAuthUrl } from "./auth.server";
import { getCustomerToken } from "./db.server";

/**
 * Client for interacting with Model Context Protocol (MCP) API endpoints.
 * Manages connections to both customer and storefront MCP endpoints, and handles tool invocation.
 */
class MCPClient {
  /**
   * @param {string} hostUrlOrDomain - myshopify domain or URL (e.g., nice-demo-store-ch.myshopify.com)
   * @param {string} conversationId  - ID for the current conversation
   * @param {string} shopId          - ID of the Shopify shop
   * @param {string} customerMcpEndpoint - Optional explicit Customer MCP endpoint
   */
  constructor(hostUrlOrDomain, conversationId, shopId, customerMcpEndpoint) {
    // Normalize to hostname (no protocol, no trailing slash)
    const hasProtocol = /^https?:\/\//i.test(hostUrlOrDomain);
    const hostname = hasProtocol
      ? new URL(hostUrlOrDomain).hostname
      : hostUrlOrDomain;

    this.shopDomain = hostname; // expected like nice-demo-store-ch.myshopify.com
    this.conversationId = conversationId;
    this.shopId = shopId;

    // Prefer your custom domain for Storefront MCP if provided via env,
    // otherwise use myshopify.com domain to avoid password/redirect HTML.
    const storefrontBase =
      (process.env.STOREFRONT_BASE_URL &&
        process.env.STOREFRONT_BASE_URL.replace(/\/+$/, "")) ||
      `https://${this.shopDomain}`;

    this.storefrontMcpEndpoint = `${storefrontBase}/api/mcp`;

    // Customer Accounts MCP runs on the account subdomain of myshopify.com:
    // nice-demo-store-ch.account.myshopify.com
    const accountHost = this.shopDomain.replace(
      /\.myshopify\.com$/i,
      ".account.myshopify.com"
    );
    this.customerMcpEndpoint =
      customerMcpEndpoint ||
      `https://${accountHost}/customer/api/mcp`;

    this.customerAccessToken = "";
    this.tools = [];
    this.customerTools = [];
    this.storefrontTools = [];
  }

  /**
   * Connects to the customer MCP server and retrieves available tools.
   */
  async connectToCustomerServer() {
    try {
      console.log(`Connecting to MCP server at ${this.customerMcpEndpoint}`);

      if (this.conversationId) {
        const dbToken = await getCustomerToken(this.conversationId);
        if (dbToken?.accessToken) {
          this.customerAccessToken = dbToken.accessToken;
        } else {
          console.log(
            "No token in database for conversation:",
            this.conversationId
          );
        }
      }

      const headers = {
        "Content-Type": "application/json",
        ...(this.customerAccessToken
          ? { Authorization: `Bearer ${this.customerAccessToken}` }
          : {}),
      };

      const response = await this._makeJsonRpcRequest(
        this.customerMcpEndpoint,
        "tools/list",
        {},
        headers
      );

      const toolsData =
        response?.result && response.result.tools ? response.result.tools : [];
      const customerTools = this._formatToolsData(toolsData);

      this.customerTools = customerTools;
      this.tools = [...this.tools, ...customerTools];

      return customerTools;
    } catch (e) {
      console.error("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  /**
   * Connects to the storefront MCP server and retrieves available tools.
   */
  async connectToStorefrontServer() {
    try {
      console.log(`Connecting to MCP server at ${this.storefrontMcpEndpoint}`);

      const headers = {
        "Content-Type": "application/json",
      };

      const response = await this._makeJsonRpcRequest(
        this.storefrontMcpEndpoint,
        "tools/list",
        {},
        headers
      );

      const toolsData =
        response?.result && response.result.tools ? response.result.tools : [];
      const storefrontTools = this._formatToolsData(toolsData);

      this.storefrontTools = storefrontTools;
      this.tools = [...this.tools, ...storefrontTools];

      return storefrontTools;
    } catch (e) {
      console.error("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  /**
   * Dispatches a tool call to the appropriate MCP server based on the tool name.
   */
  async callTool(toolName, toolArgs) {
    if (this.customerTools.some((tool) => tool.name === toolName)) {
      return this.callCustomerTool(toolName, toolArgs);
    } else if (this.storefrontTools.some((tool) => tool.name === toolName)) {
      return this.callStorefrontTool(toolName, toolArgs);
    } else {
      throw new Error(`Tool ${toolName} not found`);
    }
  }

  /**
   * Calls a tool on the storefront MCP server.
   */
  async callStorefrontTool(toolName, toolArgs) {
    try {
      console.log("Calling storefront tool", toolName, toolArgs);

      const headers = {
        "Content-Type": "application/json",
      };

      const response = await this._makeJsonRpcRequest(
        this.storefrontMcpEndpoint,
        "tools/call",
        {
          name: toolName,
          arguments: toolArgs,
        },
        headers
      );

      return response.result || response;
    } catch (error) {
      console.error(`Error calling tool ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Calls a tool on the customer MCP server (handles auth).
   */
  async callCustomerTool(toolName, toolArgs) {
    try {
      console.log("Calling customer tool", toolName, toolArgs);

      let accessToken = this.customerAccessToken;

      if (!accessToken) {
        const dbToken = await getCustomerToken(this.conversationId);
        if (dbToken?.accessToken) {
          accessToken = dbToken.accessToken;
          this.customerAccessToken = accessToken;
        } else {
          console.log(
            "No token in database for conversation:",
            this.conversationId
          );
        }
      }

      const headers = {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      };

      try {
        const response = await this._makeJsonRpcRequest(
          this.customerMcpEndpoint,
          "tools/call",
          {
            name: toolName,
            arguments: toolArgs,
          },
          headers
        );

        return response.result || response;
      } catch (error) {
        if (error.status === 401) {
          console.log("Unauthorized, generating authorization URL for customer");
          const authResponse = await generateAuthUrl(
            this.conversationId,
            this.shopId
          );

          return {
            error: {
              type: "auth_required",
              data: `You need to authorize the app to access your customer data. [Click here to authorize](${authResponse.url})`,
            },
          };
        }
        throw error;
      }
    } catch (error) {
      console.error(`Error calling tool ${toolName}:`, error);
      return {
        error: {
          type: "internal_error",
          data: `Error calling tool ${toolName}: ${error.message}`,
        },
      };
    }
  }

  /**
   * Makes a JSON-RPC request and provides helpful diagnostics if the response is HTML.
   */
  async _makeJsonRpcRequest(endpoint, method, params, headers) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        id: Date.now(),
        params,
      }),
    });

    const text = await res.text();

    if (!res.ok) {
      const err = new Error(
        `Request failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`
      );
      err.status = res.status;
      throw err;
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      console.error("MCP response not JSON", {
        endpoint,
        status: res.status,
        location: res.headers.get("location"),
        snippet: text.slice(0, 200),
      });
      throw e;
    }
  }

  /**
   * Formats raw tool data into a consistent format.
   */
  _formatToolsData(toolsData) {
    return toolsData.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema || tool.input_schema,
    }));
    }
}

export default MCPClient;
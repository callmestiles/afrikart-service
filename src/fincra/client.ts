import {
  FincraAccountVerification,
  FincraCheckoutResponse,
  FincraEnvelope,
  FincraPayout,
  FincraQuote,
  FincraWallet,
} from "./types";
import { FincraError, FincraNetworkError } from "./errors";
import { config } from "./../config";

export class FincraClient {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly publicKey: string;

  constructor() {
    this.baseUrl = config.fincra.baseUrl;
    this.secretKey = config.fincra.secretKey;
    this.publicKey = config.fincra.publicKey;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────
  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      authType?: "secret" | "public" | "none";
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const { body, authType = "secret", idempotencyKey } = options;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (authType === "secret") {
      headers["api-key"] = this.secretKey;
    } else if (authType === "public") {
      headers["x-pub-key"] = this.publicKey;
    }

    if (idempotencyKey) {
      headers["x-idempotency-key"] = idempotencyKey;
    }

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new FincraNetworkError(
        `Network error calling Fincra ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    let json: FincraEnvelope<T>;

    try {
      json = (await response.json()) as FincraEnvelope<T>;
    } catch {
      throw new FincraNetworkError(
        `Fincra returned non-JSON response for ${method} ${path} (status ${response.status})`,
      );
    }

    if (!response.ok || !json.success) {
      throw new FincraError(
        json.error ??
          `Fincra ${method} ${path} failed with status ${response.status}`,
        response.status,
        json.errorType,
      );
    }

    return json.data;
  }

  // ─── Collections ─────────────────────────────────────────────────────────

  async initiateCheckout(params: {
    amount: number;
    currency: string;
    reference: string;
    customer: { name: string; email: string };
    metadata?: Record<string, unknown>;
  }): Promise<FincraCheckoutResponse> {
    return this.request<FincraCheckoutResponse>("POST", "/checkout/initiate", {
      authType: "public",
      body: {
        amount: params.amount,
        currency: params.currency,
        reference: params.reference,
        feeBearer: "business",
        customer: params.customer,
        metadata: params.metadata ?? {},
      },
    });
  }

  async getPayment(
    reference: string,
  ): Promise<FincraCheckoutResponse["payment"]> {
    return this.request("GET", `/checkout/payments/${reference}`);
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async verifyAccountNumber(params: {
    accountNumber: string;
    bankCode: string;
  }): Promise<FincraAccountVerification> {
    return this.request<FincraAccountVerification>(
      "POST",
      "/identity/verify-account-number",
      {
        body: {
          accountNumber: params.accountNumber,
          bankCode: params.bankCode,
        },
      },
    );
  }

  // ─── FX Quotes ───────────────────────────────────────────────────────────

  async getQuote(params: {
    sourceCurrency: string;
    destinationCurrency: string;
    amount: number;
  }): Promise<FincraQuote> {
    return this.request<FincraQuote>("POST", "/conversions/quotes", {
      body: {
        sourceCurrency: params.sourceCurrency,
        destinationCurrency: params.destinationCurrency,
        amount: params.amount,
        action: "send",
      },
    });
  }

  // ─── Payouts ─────────────────────────────────────────────────────────────

  async initiatePayout(
    params: {
      amount: number;
      sourceCurrency: string;
      destinationCurrency: string;
      customerReference: string;
      narration: string;
      recipient: {
        name: string;
        accountNumber: string;
        bankCode: string;
        email?: string;
      };
      quoteReference?: string;
    },
    idempotencyKey: string,
  ): Promise<FincraPayout> {
    return this.request<FincraPayout>("POST", "/disbursements/payouts/bank", {
      idempotencyKey,
      body: {
        amount: params.amount,
        sourceCurrency: params.sourceCurrency,
        destinationCurrency: params.destinationCurrency,
        customerReference: params.customerReference,
        narration: params.narration,
        recipient: params.recipient,
        quoteReference: params.quoteReference,
      },
    });
  }

  async getPayout(reference: string): Promise<FincraPayout> {
    return this.request<FincraPayout>(
      "GET",
      `/disbursements/payouts/reference/${reference}`,
    );
  }

  // ─── Wallets ─────────────────────────────────────────────────────────────

  async getWallets(): Promise<FincraWallet[]> {
    return this.request<FincraWallet[]>("GET", "/wallets");
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  async getEvents(params?: {
    event?: string;
    limit?: number;
  }): Promise<unknown[]> {
    const query = new URLSearchParams();
    if (params?.event) query.set("event", params.event);
    if (params?.limit) query.set("limit", String(params.limit));
    const qs = query.toString();

    return this.request<unknown[]>("GET", `/events${qs ? `?${qs}` : ""}`);
  }
}

// Singleton instance to be used everywhere
export const fincraClient = new FincraClient();

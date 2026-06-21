export interface FincraPayment {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  fee: number;
  vat: number;
  feeBearer: string;
  status: string;
  customer: {
    name: string;
    email: string;
  };
  metadata: Record<string, unknown>;
  virtualAccount: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    bankCode: string;
    expiresAt: string;
  };
  channel?: string;
  amountReceived?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FincraCheckoutResponse {
  reference: string;
  checkoutUrl: string;
  payment: FincraPayment;
}

export interface FincraAccountVerification {
  accountNumber: string;
  bankCode: string;
  accountName: string;
  bankName: string;
  currency: string;
  resolved: boolean;
}

export interface FincraQuote {
  sourceCurrency: string;
  destinationCurrency: string;
  sourceAmount: number;
  destinationAmount: number;
  fee: number;
  rate: number;
  amountToCharge: number;
  amountToReceive: number;
  reference: string;
  expireAt: string;
}

export interface FincraPayout {
  id: string;
  reference: string;
  customerReference: string | null;
  amountCharged: number;
  amountReceived: number;
  sourceCurrency: string;
  destinationCurrency: string;
  fee: number;
  rate: number;
  status: string;
  reason: string;
  recipient: {
    name: string;
    accountNumber: string;
    bankCode: string;
    email?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface FincraWallet {
  currency: string;
  balance: number;
  availableBalance: number;
}

// Every Fincra response comes wrapped in this envelope
export interface FincraEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
  errorType?: string;
}

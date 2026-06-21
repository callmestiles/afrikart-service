import { input, select, confirm } from "@inquirer/prompts";

const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:3000";
const SANDBOX_URL = process.env.SANDBOX_URL ?? "http://localhost:4000";
const SANDBOX_KEY = process.env.FINCRA_SECRET_KEY ?? "sk_test_afrikart_secret";

// ─── Display Helpers ──────────────────────────────────────────────────────────

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printDivider(): void {
  console.log("\n" + "─".repeat(60) + "\n");
}

function printSuccess(msg: string): void {
  console.log(`\n✅ ${msg}`);
}

function printError(msg: string): void {
  console.log(`\n❌ ${msg}`);
}

function printInfo(msg: string): void {
  console.log(`\nℹ️  ${msg}`);
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json() };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function initiateOrder(): Promise<void> {
  printDivider();
  console.log("📦 INITIATE NEW ORDER\n");

  const orderId = await input({
    message: "Order ID:",
    default: `order_${Date.now()}`,
  });

  const amount = await input({
    message: "Amount (NGN):",
    default: "25000",
  });

  const customerName = await input({
    message: "Customer name:",
    default: "Maya Okafor",
  });

  const customerEmail = await input({
    message: "Customer email:",
    default: "maya@example.com",
  });

  const { status, body } = await post(`${SERVICE_URL}/orders`, {
    orderId,
    amount: Number(amount),
    currency: "NGN",
    customer: { name: customerName, email: customerEmail },
  });

  if (status === 201) {
    const data = (
      body as {
        data: {
          reference: string;
          virtualAccount: {
            bankName: string;
            accountNumber: string;
            accountName: string;
          };
        };
      }
    ).data;
    printSuccess("Order created successfully");
    console.log(`\n  Reference:      ${data.reference}`);
    console.log(`  Bank:           ${data.virtualAccount.bankName}`);
    console.log(`  Account Name:   ${data.virtualAccount.accountName}`);
    console.log(`  Account Number: ${data.virtualAccount.accountNumber}`);
    console.log(
      `\n  Share these virtual account details with the customer to complete payment.`,
    );
  } else {
    printError(`Failed to create order (${status})`);
    printJson(body);
  }
}

async function simulateSettlement(): Promise<void> {
  printDivider();
  console.log("💰 SIMULATE CUSTOMER PAYMENT\n");

  const reference = await input({
    message: "Order reference (pay_...):",
  });

  const { status, body } = await post(
    `${SANDBOX_URL}/simulate/collections/settle`,
    { reference, status: "successful", channel: "bank_transfer" },
    { "api-key": SANDBOX_KEY },
  );

  if (status === 200 || status === 201) {
    printSuccess(
      "Settlement simulated — webhook will be fired to your service",
    );
    printInfo(
      "Wait 1-2 seconds for the webhook to be processed, then check the order status.",
    );
  } else {
    printError(`Settlement simulation failed (${status})`);
    printJson(body);
  }
}

async function initiateVendorPayout(): Promise<void> {
  printDivider();
  console.log("💸 INITIATE VENDOR PAYOUT\n");

  const orderReference = await input({
    message: "Order reference (pay_...):",
  });

  interface RecipientChoice {
    name: string;
    accountNumber: string;
    bankCode: string;
  }

  const accountChoice = await select<RecipientChoice | null>({
    message: "Select recipient account:",
    choices: [
      {
        name: "Kofi Mensah — 0001112223 (Access) — Payout happy path",
        value: {
          name: "Kofi Mensah",
          accountNumber: "0001112223",
          bankCode: "044",
        },
      },
      {
        name: "Chinwe Obi — 2233445566 (First Bank) — Payout happy path",
        value: {
          name: "Chinwe Obi",
          accountNumber: "2233445566",
          bankCode: "011",
        },
      },
      {
        name: "Emeka Nwosu — 3344556677 (UBA) — Slow payout (ends in 7)",
        value: {
          name: "Emeka Nwosu",
          accountNumber: "3344556677",
          bankCode: "033",
        },
      },
      {
        name: "Fatima Invalid — 0000000009 (GTBank) — Will fail async (ends in 9)",
        value: {
          name: "Fatima Invalid",
          accountNumber: "0000000009",
          bankCode: "058",
        },
      },
      {
        name: "Ada Lovelace — 0123456789 (GTBank) — Collection only (ends in 9, payout fails)",
        value: {
          name: "Ada Lovelace",
          accountNumber: "0123456789",
          bankCode: "058",
        },
      },
      { name: "Custom account", value: null },
    ],
  });

  let recipient: RecipientChoice | null = accountChoice;

  const { status, body } = await post(`${SERVICE_URL}/payouts/vendor`, {
    orderReference,
    recipient,
    sourceCurrency: "NGN",
    destinationCurrency: "NGN",
  });

  if (status === 202) {
    const data = (
      body as {
        data: {
          payoutReference: string;
          recipient: { name: string; bankName: string };
        };
      }
    ).data;
    printSuccess("Payout initiated successfully");
    console.log(`\n  Payout Reference: ${data.payoutReference}`);
    console.log(
      `  Recipient:        ${data.recipient.name} at ${data.recipient.bankName}`,
    );
    console.log(`  Status:           processing`);
    printInfo("Awaiting payout webhook. Check timeline in a few seconds.");
  } else {
    printError(`Payout failed (${status})`);
    printJson(body);
  }
}

async function checkTimeline(): Promise<void> {
  printDivider();
  console.log("📋 TRANSACTION TIMELINE\n");

  const searchBy = await select({
    message: "Search by:",
    choices: [
      { name: "Checkout reference (pay_...)", value: "reference" },
      { name: "Order ID (order_...)", value: "orderId" },
    ],
  });

  const value = await input({
    message: searchBy === "reference" ? "Checkout reference:" : "Order ID:",
  });

  const url =
    searchBy === "reference"
      ? `${SERVICE_URL}/timeline/${value}`
      : `${SERVICE_URL}/timeline/order/${value}`;

  const { status, body } = await get(url);

  if (status !== 200) {
    printError(`Not found (${status})`);
    printJson(body);
    return;
  }

  if (searchBy === "orderId") {
    // orderId response contains multiple attempts
    const data = (
      body as {
        data: {
          orderId: string;
          totalAttempts: number;
          attempts: Array<{
            currentStatus: string;
            statusDescription: string;
            amount: number;
            currency: string;
            customer: { name: string };
            reference: string;
            timeline: Array<{
              event: string;
              detail: string;
              timestamp: string;
            }>;
            identifierChain: Record<string, string | null>;
          }>;
        };
      }
    ).data;

    printSuccess(
      `Found ${data.totalAttempts} attempt(s) for order ${data.orderId}`,
    );

    // Display each attempt
    data.attempts.forEach((attempt, index) => {
      console.log(`\n  ── Attempt ${index + 1} ──`);
      console.log(`  Reference:   ${attempt.reference}`);
      console.log(`  Status:      ${attempt.currentStatus}`);
      console.log(`  Description: ${attempt.statusDescription}`);
      console.log(
        `  Amount:      ${attempt.currency} ${attempt.amount.toLocaleString()}`,
      );

      console.log("\n  IDENTIFIER CHAIN:");
      Object.entries(attempt.identifierChain).forEach(([key, val]) => {
        if (val) console.log(`    ${key}: ${val}`);
      });

      console.log("\n  TIMELINE:");
      attempt.timeline.forEach((event, i) => {
        const time = new Date(event.timestamp).toLocaleTimeString();
        console.log(`    ${i + 1}. [${time}] ${event.event}`);
        console.log(`       ${event.detail}`);
      });
    });
  } else {
    // reference response contains a single attempt
    const data = (
      body as {
        data: {
          currentStatus: string;
          statusDescription: string;
          amount: number;
          currency: string;
          customer: { name: string };
          timeline: Array<{ event: string; detail: string; timestamp: string }>;
          identifierChain: Record<string, string | null>;
        };
      }
    ).data;

    printSuccess("Timeline retrieved");
    console.log(`\n  Status:      ${data.currentStatus}`);
    console.log(`  Description: ${data.statusDescription}`);
    console.log(
      `  Amount:      ${data.currency} ${data.amount.toLocaleString()}`,
    );
    console.log(`  Customer:    ${data.customer.name}`);

    console.log("\n  IDENTIFIER CHAIN:");
    Object.entries(data.identifierChain).forEach(([key, val]) => {
      if (val) console.log(`    ${key}: ${val}`);
    });

    console.log("\n  TIMELINE:");
    data.timeline.forEach((event, i) => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      console.log(`    ${i + 1}. [${time}] ${event.event}`);
      console.log(`       ${event.detail}`);
    });
  }
}

async function simulateDuplicateWebhook(): Promise<void> {
  printDivider();
  console.log("🔁 SIMULATE DUPLICATE WEBHOOK\n");

  // Get recent events from sandbox
  const { status, body } = await get(`${SANDBOX_URL}/events`, {
    "api-key": SANDBOX_KEY,
  });

  if (status !== 200) {
    printError("Could not fetch events from sandbox");
    return;
  }

  const events = (body as { data: Array<{ id: string; event: string }> }).data;

  if (events.length === 0) {
    printInfo(
      "No events found. Create an order and simulate settlement first.",
    );
    return;
  }

  // Show recent events to pick from
  const choices = events.slice(0, 5).map((e) => ({
    name: `${e.id} — ${e.event}`,
    value: e.id,
  }));

  const eventId = await select({
    message: "Select event to replay:",
    choices,
  });

  const replayRes = await post(
    `${SANDBOX_URL}/simulate/webhooks/replay/${eventId}`,
    {},
    { "api-key": SANDBOX_KEY },
  );

  if (replayRes.status === 200) {
    printSuccess("Webhook replayed — check your service logs");
    printInfo(
      'Your service should log: "Duplicate delivery detected — skipping"',
    );
  } else {
    printError(`Replay failed (${replayRes.status})`);
    printJson(replayRes.body);
  }
}

async function simulateChargeback(): Promise<void> {
  printDivider();
  console.log("⚠️  SIMULATE CHARGEBACK\n");

  const reference = await input({
    message: "Payment reference to chargeback (pay_...):",
  });

  const { status, body } = await post(
    `${SANDBOX_URL}/simulate/chargeback`,
    { paymentReference: reference, reason: "Unauthorized transaction" },
    { "api-key": SANDBOX_KEY },
  );

  if (status === 200 || status === 201) {
    printSuccess("Chargeback simulated — webhook fired to your service");
    printInfo(
      "Check the timeline to see the chargeback event and balance impact.",
    );
  } else {
    printError(`Chargeback simulation failed (${status})`);
    printJson(body);
  }
}

async function checkHealth(): Promise<void> {
  printDivider();
  const { status, body } = await get(`${SERVICE_URL}/health`);

  if (status === 200) {
    printSuccess("Service is healthy");
    printJson(body);
  } else {
    printError("Service health check failed");
  }
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║     AfriKart Service — Demo Console    ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`\n  Service: ${SERVICE_URL}`);
  console.log(`  Sandbox: ${SANDBOX_URL}`);

  // Quick health check on startup
  try {
    const { status } = await get(`${SERVICE_URL}/health`);
    if (status === 200) {
      printSuccess("Service is reachable\n");
    } else {
      printError("Service returned non-200 on health check. Is it running?\n");
    }
  } catch {
    printError(
      `Cannot reach service at ${SERVICE_URL}. Make sure it is running.\n`,
    );
    process.exit(1);
  }

  // Main menu loop — keeps running until user exits
  let running = true;

  while (running) {
    printDivider();

    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "📦  Initiate a new order (collection)", value: "order" },
        { name: "💰  Simulate customer payment (settlement)", value: "settle" },
        { name: "💸  Initiate vendor payout", value: "payout" },
        { name: "📋  View transaction timeline", value: "timeline" },
        { name: "🔁  Simulate duplicate webhook delivery", value: "duplicate" },
        { name: "⚠️   Simulate chargeback", value: "chargeback" },
        { name: "🏥  Check service health", value: "health" },
        { name: "🚪  Exit", value: "exit" },
      ],
    });

    try {
      switch (action) {
        case "order":
          await initiateOrder();
          break;
        case "settle":
          await simulateSettlement();
          break;
        case "payout":
          await initiateVendorPayout();
          break;
        case "timeline":
          await checkTimeline();
          break;
        case "duplicate":
          await simulateDuplicateWebhook();
          break;
        case "chargeback":
          await simulateChargeback();
          break;
        case "health":
          await checkHealth();
          break;
        case "exit":
          running = false;
          console.log("\nGoodbye!\n");
          break;
      }
    } catch (err) {
      printError(
        `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

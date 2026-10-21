import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MAX_JOB_TAGS, SKILL_TAGS } from "../lib/tags";

// Hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  escrow: {
    createAndFund: vi.fn(),
    isPending: vi.fn(() => false),
    error: null as string | null,
  },
  wallet: {
    publicKey: "GCLIENT" as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    connecting: false,
    signMessage: vi.fn(async () => "sig"),
  },
  api: {
    authenticate: vi.fn(),
    createJob: vi.fn(),
    linkEscrowId: vi.fn(),
  },
}));

vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
// Fiat estimates (#76) read an external price feed; no rate in these tests.
vi.mock("../lib/prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/prices")>()),
  getFiatRates: async () => ({}),
}));
vi.mock("../hooks/useEscrow", () => ({ useEscrow: () => h.escrow }));
// Only the addresses/explorer helpers are used here; skip loading the SDK.
vi.mock("../lib/stellar", () => ({
  CONTRACT_ADDRESSES: { escrow: "CESCROW", dispute: "", reputation: "", usdc: "" },
  explorerTxUrl: (hash: string) => `https://stellar.expert/tx/${hash}`,
}));
vi.mock("../lib/api", () => ({
  authenticate: h.api.authenticate,
  createJob: h.api.createJob,
  linkEscrowId: h.api.linkEscrowId,
}));

type Page = React.ComponentType;
let PostJob: Page;

/** Re-import the page so `import.meta.env.VITE_*` stubs take effect. */
async function renderWithEnv(env: Record<string, string>): Promise<void> {
  vi.resetModules();
  vi.stubEnv("VITE_USDC_CONTRACT_ID", "");
  vi.stubEnv("VITE_XLM_CONTRACT_ID", "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  PostJob = (await import("./PostJob")).default;
  render(<PostJob />);
}

beforeEach(() => {
  // The page persists its draft in localStorage; each test must start blank.
  localStorage.clear();
  h.wallet.publicKey = "GCLIENT";
  h.escrow.isPending.mockReturnValue(false);
  h.escrow.error = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
});

describe("PostJob asset picker", () => {
  it("disables an asset with no configured SAC and defaults to one that has one", async () => {
    await renderWithEnv({ VITE_XLM_CONTRACT_ID: "CXLM" });

    const select = screen.getByRole("combobox", { name: /Payment asset/i });
    // XLM is configured on this build, so it becomes the default…
    expect((select as HTMLSelectElement).value).toBe("XLM");

    const options = Array.from(select.querySelectorAll("option"));
    const bySymbol = (s: string) =>
      options.find((o) => o.textContent?.startsWith(s)) as HTMLOptionElement;
    // …and USDC is visible but cannot be picked-then-error: it is disabled.
    expect(bySymbol("XLM").disabled).toBe(false);
    expect(bySymbol("USDC").disabled).toBe(true);
    expect(bySymbol("USDC").textContent).toContain("not configured");

    // The configured token is shown and no misconfiguration alert is raised.
    expect(screen.getByText("CXLM")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still blocks and explains when no asset is configured at all", async () => {
    await renderWithEnv({});

    const select = screen.getByRole("combobox", { name: /Payment asset/i }) as HTMLSelectElement;
    expect(select.value).toBe("USDC");
    expect(
      screen.getByText(/No contract configured for USDC/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Create & Fund Escrow/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

/** Render the form with milestone amounts filled in and read the Total line. */
async function renderTotal(amounts: string[]): Promise<string> {
  await renderWithEnv({});
  for (let i = 1; i < amounts.length; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }));
  }
  amounts.forEach((amount, i) => {
    fireEvent.change(screen.getByLabelText(new RegExp(`Amount #${i + 1}`)), {
      target: { value: amount },
    });
  });
  return screen.getByText(/^Total:/).textContent ?? "";
}

describe("PostJob skills", () => {
  it("sends the chosen skill tags with the job it creates", async () => {
    h.escrow.createAndFund.mockResolvedValue({ id: 1n, hash: "HASH" });
    h.api.createJob.mockResolvedValue({ id: "job-1" });

    await renderWithEnv({ VITE_XLM_CONTRACT_ID: "CXLM" });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Landing page" } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "A longer description of the work" },
    });
    fireEvent.change(screen.getByLabelText(/Freelancer Stellar address/), {
      target: { value: "GFREELANCER" },
    });
    fireEvent.change(screen.getByLabelText(/Amount #1/), { target: { value: "1.5" } });
    fireEvent.click(screen.getByLabelText(/Web development/));
    fireEvent.click(screen.getByLabelText(/Smart contracts/));

    fireEvent.click(screen.getByRole("button", { name: /Create & Fund Escrow/ }));

    await waitFor(() => expect(h.api.createJob).toHaveBeenCalled());
    expect(h.api.createJob.mock.calls[0][0].tags).toEqual([
      "web-development",
      "smart-contracts",
    ]);
  });

  it("caps the selection at the limit the API enforces", async () => {
    await renderWithEnv({});

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(SKILL_TAGS.length);

    for (const box of boxes.slice(0, MAX_JOB_TAGS)) fireEvent.click(box);

    expect(screen.getByText(`Skills (${MAX_JOB_TAGS}/${MAX_JOB_TAGS})`)).toBeTruthy();
    // The remaining boxes lock, so the API can never reject the selection.
    expect(boxes[MAX_JOB_TAGS].disabled).toBe(true);
  });

  it("unchecks a tag when it is clicked twice", async () => {
    await renderWithEnv({});

    const box = screen.getByLabelText(/Web development/) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);

    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(screen.getByText(`Skills (0/${MAX_JOB_TAGS})`)).toBeTruthy();
  });
});

describe("PostJob total", () => {
  it("shows the exact decimal sum, not a float artefact", async () => {
    const text = await renderTotal(["0.1", "0.1", "0.1"]);
    expect(text).toContain("0.3");
    expect(text).not.toContain("0.30000000000000004");
  });

  it("sums whole and fractional amounts exactly", async () => {
    expect(await renderTotal(["1", "0.5"])).toContain("1.5");
  });

  it("ignores empty amounts while the form is being filled in", async () => {
    expect(await renderTotal(["0.2", ""])).toContain("0.2");
  });
});

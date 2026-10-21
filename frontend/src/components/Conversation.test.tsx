/**
 * Conversation.test.tsx
 *
 * Issue #64: the job page's conversation view — it reads the thread, shows how
 * many messages were waiting, records the read receipt, and sends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ME = "GME";
const OTHER = "GOTHER";

const h = vi.hoisted(() => ({
  wallet: {
    publicKey: "GME" as string | null,
    connect: vi.fn(async () => "GME"),
    signMessage: vi.fn(async () => "sig"),
  },
  authenticate: vi.fn(async () => "jwt-1"),
  fetchMessages: vi.fn(),
  sendMessage: vi.fn(),
  markMessagesRead: vi.fn(async () => 0),
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../lib/api", () => ({
  authenticate: h.authenticate,
  fetchMessages: h.fetchMessages,
  sendMessage: h.sendMessage,
  markMessagesRead: h.markMessagesRead,
}));

import Conversation from "./Conversation";

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    jobId: "job-1",
    senderId: "user-other",
    body: "The first milestone is ready for review",
    createdAt: "2026-01-02T03:04:05.000Z",
    readAt: null,
    sender: { stellarAddress: OTHER, displayName: null },
    ...overrides,
  };
}

beforeEach(() => {
  // jsdom does not implement scrolling; the auto-scroll effect calls this.
  Element.prototype.scrollIntoView = vi.fn();
  h.wallet.publicKey = ME;
  h.authenticate.mockClear();
  h.fetchMessages.mockReset();
  h.fetchMessages.mockResolvedValue([]);
  h.sendMessage.mockReset();
  h.markMessagesRead.mockReset();
  h.markMessagesRead.mockResolvedValue(0);
});

afterEach(() => cleanup());

describe("Conversation", () => {
  it("shows the thread and records a read receipt", async () => {
    h.fetchMessages.mockResolvedValue([message()]);

    render(<Conversation jobId="job-1" />);

    expect(await screen.findByText("The first milestone is ready for review")).toBeTruthy();
    await waitFor(() =>
      expect(h.markMessagesRead).toHaveBeenCalledWith("job-1", "jwt-1"),
    );
    expect(h.fetchMessages).toHaveBeenCalledWith("job-1", "jwt-1");
  });

  it("counts the other party's unread messages from before the receipt landed", async () => {
    h.fetchMessages.mockResolvedValue([
      message(),
      message({ id: "m2", sender: { stellarAddress: OTHER }, readAt: null }),
      // Already read, and a message I sent: neither is unread for me.
      message({ id: "m3", readAt: "2026-01-02T04:00:00.000Z" }),
      message({ id: "m4", sender: { stellarAddress: ME } }),
    ]);

    render(<Conversation jobId="job-1" />);

    expect(await screen.findByText("2 unread")).toBeTruthy();
  });

  it("shows no unread badge when nothing is waiting", async () => {
    h.fetchMessages.mockResolvedValue([message({ sender: { stellarAddress: ME } })]);

    render(<Conversation jobId="job-1" />);

    await screen.findByText("The first milestone is ready for review");
    expect(screen.queryByText(/unread/)).toBeNull();
  });

  it("sends a message and shows it in the thread", async () => {
    h.fetchMessages.mockResolvedValue([]);
    h.sendMessage.mockResolvedValue(message({ id: "m9", body: "Starting on it now", senderId: "user-me" }));

    render(<Conversation jobId="job-1" />);
    await screen.findByText("No messages yet.");

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Starting on it now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(h.sendMessage).toHaveBeenCalledWith("job-1", "Starting on it now", "jwt-1"),
    );
    expect(await screen.findByText("Starting on it now")).toBeTruthy();
    // Attributed to the connected wallet, not to the respondent.
    expect(screen.getByText(/You ·/)).toBeTruthy();
  });

  it("refuses to send an empty message", async () => {
    h.fetchMessages.mockResolvedValue([]);

    render(<Conversation jobId="job-1" />);
    await screen.findByText("No messages yet.");

    // Whitespace only: the button stays disabled rather than posting a blank.
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces a refusal (e.g. a third party) as an alert", async () => {
    h.fetchMessages.mockRejectedValue(new Error("Could not load the conversation (HTTP 403)"));

    render(<Conversation jobId="job-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 403");
  });

  it("asks a disconnected visitor to connect before showing the thread", async () => {
    h.wallet.publicKey = null;

    render(<Conversation jobId="job-1" />);

    expect(screen.getByRole("button", { name: "Connect Freighter" })).toBeTruthy();
    expect(h.fetchMessages).not.toHaveBeenCalled();
  });
});

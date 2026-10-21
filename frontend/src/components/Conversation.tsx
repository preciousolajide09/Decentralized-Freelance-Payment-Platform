/**
 * Conversation.tsx
 *
 * The job-scoped conversation between a job's client and its freelancer,
 * rendered on the job page (issue #64).
 *
 * Contributor Notes:
 * - `jobId` is the *off-chain* job id: the API scopes messages to it, while the
 *   job page is keyed by the on-chain escrow id. The page resolves one to the
 *   other and only mounts this component for a participant.
 * - Opening the thread marks the other party's messages read, so the unread
 *   counts elsewhere drop. The count shown in the heading is captured *before*
 *   that receipt lands — otherwise it would always read zero.
 * - Only a participant ever reaches the API here; the server enforces the same
 *   rule, so the check is a courtesy, not the boundary.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  authenticate,
  fetchMessages,
  markMessagesRead,
  sendMessage,
  type MessageApi,
} from "../lib/api";
import { shortAddress } from "../lib/address";
import { useWallet } from "../hooks/wallet-context";

const MAX_BODY = 2000;
const POLL_INTERVAL_MS = 5000; // Poll for new messages every 5 seconds

export default function Conversation({ jobId }: { jobId: string }) {
  const { publicKey, connect, signMessage } = useWallet();
  const [messages, setMessages] = useState<MessageApi[]>([]);
  /** How many of the other party's messages were waiting when the thread opened. */
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      const list = await fetchMessages(jobId, token);
      setMessages(list);
      setUnreadAtOpen(
        list.filter((m) => m.sender?.stellarAddress !== publicKey && m.readAt === null).length,
      );
      await markMessagesRead(jobId, token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [jobId, publicKey, signMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-scroll to the latest message
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Poll for new messages every 5 seconds
  useEffect(() => {
    if (!publicKey) return;

    const pollInterval = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollInterval);
  }, [publicKey, load]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!publicKey || text.length === 0 || sending) return;

    setSending(true);
    setError(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      const sent = await sendMessage(jobId, text, token);
      // The response carries the row but not its sender relation, so tag it here
      // rather than refetching the whole conversation.
      setMessages((prev) => [...prev, { ...sent, sender: { stellarAddress: publicKey } }]);
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="conversation">
      <h2>
        Messages{" "}
        {unreadAtOpen > 0 && (
          <span className="badge badge-active">{unreadAtOpen} unread</span>
        )}
      </h2>

      {!publicKey ? (
        <p>
          <button onClick={() => void connect()}>Connect Freighter</button> to read and
          send messages.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="alert alert-error">
              {error}
            </p>
          )}

          {loading && messages.length === 0 && <p className="muted">Loading messages…</p>}
          {!loading && messages.length === 0 && !error && (
            <p className="muted">No messages yet.</p>
          )}

          {messages.length > 0 && (
            <ol className="message-list">
              {messages.map((message) => {
                const mine = message.sender?.stellarAddress === publicKey;
                return (
                  <li key={message.id} className={mine ? "message message-mine" : "message"}>
                    <span className="muted">
                      {mine
                        ? "You"
                        : shortAddress(
                            message.sender?.stellarAddress ?? "The other participant",
                          )}{" "}
                      · <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleString()}
                      </time>
                    </span>
                    <p>{message.body}</p>
                  </li>
                );
              })}
              <div ref={messagesEndRef} />
            </ol>
          )}

          <form onSubmit={handleSend}>
            <label>
              Message
              <br />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_BODY}
                rows={2}
                cols={60}
                placeholder="Ask about the work…"
              />
            </label>
            <button type="submit" disabled={sending || draft.trim().length === 0}>
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

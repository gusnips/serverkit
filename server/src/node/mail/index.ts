/**
 * Mail over SMTP, with the settings nine backends each wrote and only some of them got right.
 *
 * What the copies taught:
 * - **Every wait has a deadline.** 12 of 13 transports set none, so nodemailer's defaults
 *   applied: 2 minutes to connect and 10 minutes of silence, inside requests a person was waiting
 *   on. Here each wait is 15 seconds.
 * - **A password never crosses in clear.** nodemailer upgrades to TLS only when the server offers
 *   STARTTLS, so anyone on the path who deletes that one word gets the login as plain text.
 *   Measured on nodemailer 6.10.1, 7.0.13 and 10.0.10, on Node and Bun. With a login set, this
 *   mailer refuses to go on without TLS.
 * - **A text part is required.** One backend sent HTML only, which spam filters mark down and a
 *   text-only mail client cannot show. `textFromHtml`, at the root, writes one from the HTML.
 * - **One-click unsubscribe is two headers**, and nodemailer's own option writes one. See
 *   `listUnsubscribeHeaders`.
 * - **Port 587 is safe on Bun.** After STARTTLS, Bun keeps a copy of the encrypted bytes on the
 *   plain socket (Bun #32239), but only while that socket is paused, and nodemailer never pauses
 *   it. Measured on Bun 1.3.8 and 1.4.2 against a local server, and through the TLS handshake
 *   with two public providers.
 *
 * `nodemailer` is an optional peer, and this subpath is the only place that imports it. It lives in
 * `src/node/` because SMTP needs a TCP socket, which a Worker does not have.
 */
import nodemailer from "nodemailer";
import { listUnsubscribeHeaders } from "../../unsubscribe.ts";

export interface MailerOptions {
  /** The SMTP server. Empty or undefined turns mail off: `enabled` is false and `send` throws. */
  host: string | undefined;
  /**
   * 587 by default, which upgrades to TLS with STARTTLS. On 465 the connection is TLS from the
   * first byte. nodemailer decides that from the port, so there is no `secure` to get wrong.
   */
  port?: number;
  /**
   * Sent only when set, because a local catcher such as Mailpit takes no login. With a login,
   * the mailer requires TLS.
   */
  user?: string;
  pass?: string;
  /** Required when `host` is set. */
  from: string | { name: string; address: string };
  /** Where replies go, unless a message says otherwise. Useful when `from` is a no-reply address. */
  replyTo?: string;
  /**
   * How long any one wait may last, in milliseconds: DNS, connecting, the server's greeting, or a
   * server that goes quiet. 15 seconds by default.
   */
  timeoutMs?: number;
  /** The error `send` throws when mail is off, such as your own 503 with its message key. */
  whenDisabled?: () => Error;
}

export interface MailAttachment {
  filename: string;
  content: string | Uint8Array;
  /** Guessed from the file name when left out. */
  contentType?: string;
}

export interface MailMessage {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  /**
   * Required, even beside `html`: spam filters mark down mail without it. `textFromHtml` writes it
   * from the HTML.
   */
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** For mail sent in bulk. Writes both unsubscribe headers; see `listUnsubscribeHeaders`. */
  unsubscribeUrl?: string;
  attachments?: MailAttachment[];
}

export interface SentMail {
  messageId: string;
  /** Addresses the server refused while it took the others. When it refuses all of them, `send` throws. */
  rejected: string[];
}

export interface Mailer {
  readonly enabled: boolean;
  /** Sends one message. Throws when mail is off, and when the server refuses the message. */
  send(message: MailMessage): Promise<SentMail>;
}

const UNSUBSCRIBE_HEADER = /^list-unsubscribe(?:-post)?$/i;

/**
 *     const mailer = createMailer({
 *       host: env.SMTP_HOST,
 *       user: env.SMTP_USER,
 *       pass: env.SMTP_PASS,
 *       from: { name: "Acme", address: "no-reply@acme.test" },
 *       whenDisabled: () => errors.serviceUnavailable("Mail is not set up here"),
 *     });
 *     await mailer.send({ to, subject, text, html });
 */
export function createMailer(options: MailerOptions): Mailer {
  const { host, port = 587, user, pass, from, replyTo, timeoutMs = 15_000, whenDisabled } = options;
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0))
    throw new TypeError(`timeoutMs is a whole number of milliseconds above 0, not ${timeoutMs}`);
  if (!host)
    return {
      enabled: false,
      send: () =>
        Promise.reject(
          whenDisabled?.() ?? new Error("Mail is off: no SMTP host is set. Set one, then restart."),
        ),
    };
  if (!(typeof from === "string" ? from : from.address))
    throw new TypeError("A mailer with a host needs a from address");

  // ponytail: each wait is bounded, not the whole send, so a server that answers every 14 s can
  // hold one for minutes. nodemailer's transport gives no handle to abort a send; the upgrade is
  // its SMTPConnection, driven directly under one timer.
  const transport = nodemailer.createTransport({
    host,
    port,
    ...(user ? { auth: { user, pass }, requireTLS: true } : {}),
    dnsTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
    // Also bounds the wait for the greeting, and fires before nodemailer's own greeting timer.
    socketTimeout: timeoutMs,
  });

  return {
    enabled: true,
    async send(message) {
      const { unsubscribeUrl, headers, text, attachments, ...rest } = message;
      if (!text.trim()) throw new TypeError("A mail needs a text part, even beside its HTML");
      if (
        unsubscribeUrl &&
        Object.keys(headers ?? {}).some((name) => UNSUBSCRIBE_HEADER.test(name))
      )
        throw new TypeError(
          "Pass unsubscribeUrl or your own List-Unsubscribe headers, not both: the mail would " +
            "carry two of each.",
        );
      const info = await transport.sendMail({
        ...rest,
        from,
        replyTo: rest.replyTo ?? replyTo,
        text,
        headers: { ...headers, ...(unsubscribeUrl ? listUnsubscribeHeaders(unsubscribeUrl) : {}) },
        // nodemailer takes a plain Uint8Array (measured on 6, 7 and 10); its types ask for a Buffer.
        attachments: attachments?.map(({ content, ...attachment }) => ({
          ...attachment,
          content:
            typeof content === "string"
              ? content
              : Buffer.from(content.buffer, content.byteOffset, content.byteLength),
        })),
      });
      return {
        messageId: info.messageId,
        rejected: info.rejected.map((to) => (typeof to === "string" ? to : to.address)),
      };
    },
  };
}

import { once } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../../errors.ts";
import { createMailer, type MailerOptions } from "./index.ts";

interface Received {
  from: string | undefined;
  to: string[];
  raw: string;
}

const servers: { close: (done: () => void) => void }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(done))));
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A plain SMTP server, no TLS, that keeps every message it takes and every command it hears. */
async function startSmtp(options: SMTPServerOptions = {}) {
  const received: Received[] = [];
  const logins: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    authOptional: true,
    logger: false,
    onAuth(auth, _session, done) {
      logins.push(auth.username ?? "");
      done(null, { user: auth.username });
    },
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
          to: session.envelope.rcptTo.map((to) => to.address),
          raw: Buffer.concat(chunks).toString(),
        });
        done();
      });
    },
    ...options,
  });
  servers.push(server);
  const port = await listen(server.server);
  return { port, received, logins };
}

function mailerOn(port: number, options: Partial<MailerOptions> = {}) {
  return createMailer({ host: "127.0.0.1", port, from: "no-reply@acme.test", ...options });
}

/** The header block, with folded lines joined back up. */
const headerLines = (raw: string) =>
  raw
    .split("\r\n\r\n")[0]!
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n");

describe("createMailer", () => {
  it("sends the text and the HTML, from the mailer's address", async () => {
    const smtp = await startSmtp();
    const mailer = mailerOn(smtp.port, { from: { name: "Acme", address: "no-reply@acme.test" } });
    expect(mailer.enabled).toBe(true);

    const sent = await mailer.send({
      to: "ana@example.test",
      subject: "Your code",
      text: "Your code is 123456.",
      html: "<p>Your code is <b>123456</b>.</p>",
    });

    expect(sent.messageId).toMatch(/^<.+@acme\.test>$/);
    expect(sent.rejected).toEqual([]);
    const [mail] = smtp.received;
    expect(mail?.from).toBe("no-reply@acme.test");
    expect(mail?.to).toEqual(["ana@example.test"]);
    expect(headerLines(mail!.raw)).toContain("From: Acme <no-reply@acme.test>");
    expect(mail?.raw).toContain("Content-Type: text/plain");
    expect(mail?.raw).toContain("Your code is 123456.");
    expect(mail?.raw).toContain("<p>Your code is <b>123456</b>.</p>");
  });

  it("writes both unsubscribe headers into the mail that goes out", async () => {
    const smtp = await startSmtp();
    await mailerOn(smtp.port).send({
      to: "ana@example.test",
      subject: "This week",
      text: "Three new posts.",
      unsubscribeUrl: `https://acme.test/unsubscribe?token=${"a".repeat(200)}`,
    });
    const lines = headerLines(smtp.received[0]!.raw);
    expect(lines).toContain(
      `List-Unsubscribe: <https://acme.test/unsubscribe?token=${"a".repeat(200)}>`,
    );
    expect(lines).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("uses the mailer's reply-to unless the message names its own", async () => {
    const smtp = await startSmtp();
    const mailer = mailerOn(smtp.port, { replyTo: "help@acme.test" });
    await mailer.send({ to: "ana@example.test", subject: "a", text: "a" });
    await mailer.send({
      to: "ana@example.test",
      subject: "b",
      text: "b",
      replyTo: "ana@acme.test",
    });
    await mailer.send({ to: "ana@example.test", subject: "c", text: "c", replyTo: undefined });
    expect(
      smtp.received.map((mail) => headerLines(mail.raw).find((l) => l.startsWith("Reply-To"))),
    ).toEqual(["Reply-To: help@acme.test", "Reply-To: ana@acme.test", "Reply-To: help@acme.test"]);
  });

  it("delivers a binary attachment byte for byte", async () => {
    const smtp = await startSmtp();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await mailerOn(smtp.port).send({
      to: "ana@example.test",
      subject: "Report",
      text: "Attached.",
      attachments: [{ filename: "report.bin", content: bytes }],
    });
    expect(smtp.received[0]!.raw).toContain(Buffer.from(bytes).toString("base64"));
  });

  it("names the addresses the server refused while it took the others", async () => {
    const smtp = await startSmtp({
      onRcptTo(address, _session, done) {
        done(address.address === "gone@example.test" ? new Error("550 No such user") : undefined);
      },
    });
    const sent = await mailerOn(smtp.port).send({
      to: ["ana@example.test", "gone@example.test"],
      subject: "Hi",
      text: "Hi.",
    });
    expect(sent.rejected).toEqual(["gone@example.test"]);
    expect(smtp.received[0]?.to).toEqual(["ana@example.test"]);
  });

  it("never sends a login to a server that does not offer TLS", async () => {
    // What a server looks like after somebody on the path deleted STARTTLS from its greeting.
    const smtp = await startSmtp({
      hideSTARTTLS: true,
      disabledCommands: [],
      allowInsecureAuth: true,
    });
    const mailer = mailerOn(smtp.port, { user: "acme", pass: "hunter2", timeoutMs: 2_000 });
    await expect(
      mailer.send({ to: "ana@example.test", subject: "Hi", text: "Hi." }),
    ).rejects.toThrow();
    expect(smtp.logins).toEqual([]);
    expect(smtp.received).toEqual([]);
  });

  it("sends without TLS when there is no login, as a local mail catcher needs", async () => {
    const smtp = await startSmtp();
    await mailerOn(smtp.port).send({ to: "ana@example.test", subject: "Hi", text: "Hi." });
    expect(smtp.received).toHaveLength(1);
  });

  it("gives up on a server that never says hello, within the timeout", async () => {
    const sockets: Socket[] = [];
    const silent = createServer((socket) => void sockets.push(socket));
    servers.push({
      close: (done) => {
        for (const socket of sockets) socket.destroy();
        silent.close(() => done());
      },
    });
    const port = await listen(silent);
    const started = Date.now();
    await expect(
      mailerOn(port, { timeoutMs: 300 }).send({
        to: "ana@example.test",
        subject: "Hi",
        text: "Hi.",
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a message without a text part, before connecting", async () => {
    const smtp = await startSmtp();
    await expect(
      mailerOn(smtp.port).send({
        to: "ana@example.test",
        subject: "Hi",
        text: " ",
        html: "<p>Hi</p>",
      }),
    ).rejects.toThrow("A mail needs a text part");
    expect(smtp.received).toEqual([]);
  });

  it("refuses an unsubscribe link beside hand-written unsubscribe headers", async () => {
    const smtp = await startSmtp();
    await expect(
      mailerOn(smtp.port).send({
        to: "ana@example.test",
        subject: "Hi",
        text: "Hi.",
        headers: { "list-unsubscribe": "<https://acme.test/old>" },
        unsubscribeUrl: "https://acme.test/unsubscribe?token=t",
      }),
    ).rejects.toThrow("Pass unsubscribeUrl or your own List-Unsubscribe headers, not both");
  });

  it("refuses a host without a from address, and a timeout that is not a whole number above 0", () => {
    expect(() => createMailer({ host: "smtp.acme.test", from: "" })).toThrow(
      "A mailer with a host needs a from address",
    );
    for (const timeoutMs of [0, -1, 1.5, Number.NaN])
      expect(() =>
        createMailer({ host: "smtp.acme.test", from: "a@acme.test", timeoutMs }),
      ).toThrow("timeoutMs is a whole number");
  });
});

describe("a mailer with no host", () => {
  it("is off, and its send throws your error", async () => {
    const refusal = new Error("503 mail is not set up");
    const mailer = createMailer({ host: "", from: "", whenDisabled: () => refusal });
    expect(mailer.enabled).toBe(false);
    await expect(mailer.send({ to: "ana@example.test", subject: "Hi", text: "Hi." })).rejects.toBe(
      refusal,
    );
  });

  it("says how to turn it on when you gave no error of your own", async () => {
    const mailer = createMailer({ host: undefined, from: "" });
    await expect(
      mailer.send({ to: "ana@example.test", subject: "Hi", text: "Hi." }),
    ).rejects.toThrow("Mail is off: no SMTP host is set. Set one, then restart.");
  });
});

// The README's snippet. It lives here and not in readme.test.ts, whose program is the Worker's.
describe("README — sending mail", () => {
  it("sends the code, and a mailer with no host throws the product's own 503", async () => {
    const smtp = await startSmtp();
    const errors = {
      serviceUnavailable: (message: string) =>
        new AppError(503, "SERVICE_UNAVAILABLE", message, { expose: true }),
    };
    const user = { email: "ana@example.test" };
    const code = "123456";
    for (const env of [{ SMTP_HOST: "127.0.0.1" }, { SMTP_HOST: "" }]) {
      const mailer = createMailer({
        host: env.SMTP_HOST,
        port: smtp.port,
        from: { name: "Acme", address: "no-reply@acme.test" },
        whenDisabled: () => errors.serviceUnavailable("Mail is not set up on this server"),
      });
      const sending = mailer.send({
        to: user.email,
        subject: "Your code",
        text: `Your code is ${code}.`,
      });
      if (mailer.enabled) await sending;
      else await expect(sending).rejects.toMatchObject({ statusCode: 503, expose: true });
    }
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]?.raw).toContain("Your code is 123456.");
  });
});

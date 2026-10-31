/**
 * Ghostty terminal: a real shell in a page, drawn on the server by Ghostty's own VT engine and typed into from the
 * browser module beside this file.
 *
 * Pi Pocket runs on Node, and Ghostty's binding (`libghostty-vt`) needs Bun's FFI. So this module starts one Bun
 * process for each terminal (`pty-host.ts`, in its runtime folder), gives it a pty, and passes JSON lines in and out.
 * A terminal ends with the server or with this module's next version: no shell outlives them.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Web, WebRequest, WebSession } from "./_pocket.d.ts";

/** A piece of a row that shares a look: `[text, foreground, background, flags]`. An empty color is the default. */
type Run = [text: string, fg: string, bg: string, flags: number];

/** The cursor as the running program asked for it: DECSCUSR's shape, and whether it blinks. */
type CursorShape = "block" | "underline" | "bar";

/** What the browser needs to draw the screen. Only the rows in `lines` are new since the frame before. */
interface Frame {
    seq: number;
    full: boolean;
    cols: number;
    rows: number;
    title: string;
    cursor: { x: number; y: number; visible: boolean; shape: CursorShape; blink: boolean };
    alt: boolean;
    scroll: { scrollback: number };
    lines: Array<{ y: number; runs: Run[] }>;
}

/** One terminal: its process, and the screen as it was after the last frame. */
interface Terminal {
    id: string;
    cwd: string;
    argv: string[];
    cols: number;
    rows: number;
    createdAt: number;
    title: string;
    alive: boolean;
    exitCode: number | null;
    signal: string | null;
    proc: ChildProcessWithoutNullStreams;
    screen: Run[][];
    cursor: Frame["cursor"];
    alt: boolean;
    scrollback: number;
    seq: number;
}

/** The most terminals at once. Beyond it, a new one is refused. */
const MAX_TERMINALS = 8;

/** How long a terminal that ended stays in the list, so its page can say what happened. */
const KEEP_ENDED_MS = 15 * 60_000;

/** The environment that a terminal's shell gets: the person's own, less anything that is only about this server. */
const KEPT_ENV =
    /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TMPDIR|TZ|EDITOR|VISUAL|PAGER|MANPAGER|SSH_AUTH_SOCK|DISPLAY|WAYLAND_DISPLAY|XDG_[A-Z_]+|LC_[A-Z]+|GIT_[A-Z_]+|COLORTERM|NO_COLOR|FORCE_COLOR)$/;

export default function createGhosttyTerminal(_host: unknown, web: Web) {
    const terminals = new Map<string, Terminal>();

    if (typeof web.settings === "function") {
        web.settings([
            {
                name: "command",
                label: "Shell",
                type: "text",
                placeholder: "bash",
                description: "The program that a new terminal runs, with -l. Empty runs the person's own shell.",
            },
            {
                name: "bun",
                label: "Bun",
                type: "text",
                placeholder: "bun",
                description: "The Bun binary that runs Ghostty's binding. Empty finds it in PATH, or in mise's installs.",
            },
            {
                name: "runtime",
                label: "Runtime folder",
                type: "text",
                placeholder: join(homedir(), ".pi-pocket", "ghostty-terminal"),
                description: "The folder with pty-host.ts and libghostty-vt. Empty uses the placeholder.",
            },
        ]);
    }

    const setting = (name: string): string => {
        const value = typeof web.setting === "function" ? web.setting(name) : undefined;

        return typeof value === "string" ? value.trim() : "";
    };

    const runtimeDir = (): string => setting("runtime") || join(homedir(), ".pi-pocket", "ghostty-terminal");

    /** The Bun binary that can run the binding: the setting, `GHOSTTY_TERM_BUN`, PATH, or mise's installs. */
    function findBun(): string | null {
        const named = setting("bun") || process.env.GHOSTTY_TERM_BUN || "";

        if (named.includes("/")) {
            if (existsSync(named)) return named;
        } else if (named !== "") {
            for (const folder of (process.env.PATH ?? "").split(delimiter)) {
                if (existsSync(join(folder, named))) return join(folder, named);
            }
        }

        const installs = join(homedir(), ".local", "share", "mise", "installs", "bun");

        if (existsSync(installs)) {
            const found = readdirSync(installs)
                .map((each) => join(installs, each, "bin", "bun"))
                .filter((each) => existsSync(each))
                .sort();

            if (found.length > 0) return found.at(-1)!;
        }

        for (const candidate of [join(homedir(), ".bun", "bin", "bun"), "/usr/local/bin/bun", "/usr/bin/bun"]) {
            if (existsSync(candidate)) return candidate;
        }

        return null;
    }

    /** The shell that a new terminal runs, and its arguments. */
    function shell(): string[] {
        // `-l` reads the person's own profile, as their terminal does.
        return [setting("command") || process.env.SHELL || "/bin/bash", "-l"];
    }

    /** What the pty gets, in a shape that a command line can carry. */
    function environment(): Record<string, string> {
        const env: Record<string, string> = {};

        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined && KEPT_ENV.test(name)) env[name] = value;
        }

        env.TERM = "xterm-256color";
        env.COLORTERM = "truecolor";

        return env;
    }

    function summary(terminal: Terminal) {
        return {
            id: terminal.id,
            cwd: terminal.cwd,
            argv: terminal.argv,
            cols: terminal.cols,
            rows: terminal.rows,
            title: terminal.title,
            alive: terminal.alive,
            exitCode: terminal.exitCode,
            signal: terminal.signal,
            createdAt: terminal.createdAt,
        };
    }

    /** The whole screen, for a page that just opened or reloaded. */
    function snapshot(terminal: Terminal): Frame {
        return {
            seq: terminal.seq,
            full: true,
            cols: terminal.cols,
            rows: terminal.rows,
            title: terminal.title,
            cursor: terminal.cursor,
            alt: terminal.alt,
            scroll: { scrollback: terminal.scrollback },
            lines: terminal.screen.map((runs, y) => ({ y, runs })),
        };
    }

    function tell(terminal: Terminal, frame: Frame): void {
        web.send("frame", { id: terminal.id, frame });
    }

    /** Takes one JSON line from the runner: a frame, or a word about the pty. */
    function read(terminal: Terminal, line: string): void {
        let message: Record<string, unknown>;

        try {
            message = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return;
        }

        if (message.t === "frame") {
            const frame = message as unknown as Frame;

            terminal.seq = frame.seq;
            terminal.cols = frame.cols;
            terminal.rows = frame.rows;
            terminal.title = frame.title;
            terminal.cursor = frame.cursor;
            terminal.alt = frame.alt;
            terminal.scrollback = frame.scroll?.scrollback ?? 0;

            if (frame.full || terminal.screen.length !== frame.rows) {
                terminal.screen = Array.from({ length: frame.rows }, () => []);
            }

            for (const { y, runs } of frame.lines) {
                if (y >= 0 && y < terminal.screen.length) terminal.screen[y] = runs;
            }

            tell(terminal, frame);
        } else if (message.t === "exit") {
            if (terminal.alive) {
                terminal.alive = false;
                terminal.exitCode = typeof message.code === "number" ? message.code : null;
                terminal.signal = typeof message.signal === "string" ? message.signal : null;
                web.send("exit", { id: terminal.id, code: terminal.exitCode, signal: terminal.signal });
            }
        } else if (message.t === "clipboard") {
            // A program copied something: the clipboard is the browser's and the system's, so the page writes it.
            web.send("clipboard", { id: terminal.id, selection: message.selection, text: message.text });
        } else if (message.t === "clipboard-query") {
            // A program asked what the clipboard holds: the page reads it, and answers through the route.
            web.send("clipboard-read", { id: terminal.id, selection: message.selection });
        } else if (message.t === "error" || message.t === "bell") {
            web.send("notice", { id: terminal.id, kind: String(message.t), message: String(message.message ?? "bell") });
        }
    }

    function write(terminal: Terminal, message: Record<string, unknown>): void {
        if (terminal.proc.stdin.destroyed) return;

        terminal.proc.stdin.write(`${JSON.stringify(message)}\n`);
    }

    /** Starts the runner for one terminal and gives it the pty. */
    function start(cwd: string, cols: number, rows: number): Terminal {
        const bun = findBun();
        const runner = join(runtimeDir(), "pty-host.ts");

        if (bun === null) {
            throw web.error(
                503,
                "This extension needs Bun to run Ghostty's binding. Install Bun (https://bun.sh), or set the Bun binary in Menu → Extensions → Ghostty terminal.",
            );
        }

        if (!existsSync(runner)) {
            throw web.error(
                503,
                `This extension needs its runtime folder, ${runtimeDir()}. Run the install step again (the extension's README tells how).`,
            );
        }

        const proc = spawn(bun, ["run", runner], {
            cwd: runtimeDir(),
            env: environment(),
            stdio: ["pipe", "pipe", "pipe"],
        });

        const terminal: Terminal = {
            id: randomUUID(),
            cwd,
            argv: shell(),
            cols,
            rows,
            createdAt: Date.now(),
            title: "",
            alive: true,
            exitCode: null,
            signal: null,
            proc,
            screen: Array.from({ length: rows }, () => []),
            cursor: { x: 0, y: 0, visible: true, shape: "block", blink: false },
            alt: false,
            scrollback: 0,
            seq: 0,
        };

        let buffer = "";

        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
            buffer += chunk;

            const cut = buffer.lastIndexOf("\n");

            if (cut < 0) return;

            const lines = buffer.slice(0, cut).split("\n");

            buffer = buffer.slice(cut + 1);

            for (const line of lines) {
                if (line.trim() !== "") read(terminal, line);
            }
        });

        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
            const text = chunk.trim();

            if (text !== "") web.send("notice", { id: terminal.id, kind: "stderr", message: text.slice(0, 500) });
        });

        proc.on("error", (error) => {
            web.send("notice", { id: terminal.id, kind: "error", message: error.message });
        });

        // The runner went without saying how the shell went: its own code is all that is left to say.
        proc.on("exit", (code) => {
            if (terminal.alive) {
                terminal.alive = false;
                terminal.exitCode = code;
                web.send("exit", { id: terminal.id, code, signal: null });
            }
        });

        write(terminal, { op: "spawn", argv: terminal.argv, cwd, cols, rows, env: environment() });

        return terminal;
    }

    /** The terminal that a path names, or the 404 that a page cannot tell from a route that is not there. */
    function find(request: WebRequest): Terminal {
        const terminal = terminals.get(request.params.id ?? "");

        if (terminal === undefined) throw web.error(404, "No such terminal");

        return terminal;
    }

    /** A whole number in a range, or the fallback. */
    function size(value: unknown, least: number, most: number, fallback: number): number {
        const number = Math.round(Number(value));

        return Number.isFinite(number) && number >= least && number <= most ? number : fallback;
    }

    /** The folder that a terminal starts in: the session's, when the page names one that its person can see. */
    function folderOf(sessions: readonly WebSession[], conversation: unknown): string {
        const wanted = Number(conversation);

        if (!Number.isFinite(wanted)) return homedir();

        const session = sessions.find((each) => each.id === wanted);

        if (session === undefined) throw web.error(403, "That session is not yours to see");

        return session.cwd;
    }

    web.route("GET", "terminals", () => ({
        terminals: [...terminals.values()].map(summary),
        bun: findBun() !== null,
        runner: existsSync(join(runtimeDir(), "pty-host.ts")),
    }));

    web.route("POST", "terminals", (request) => {
        const cwd = folderOf(request.sessions(), request.body.conversation);
        const cols = size(request.body.cols, 20, 400, 80);
        const rows = size(request.body.rows, 5, 200, 24);

        // One terminal for each folder: the page that reopens finds the one that it left. A second pane of the same
        // folder asks for a shell of its own, and gets one.
        const existing =
            request.body.new === true ? undefined : [...terminals.values()].find((each) => each.alive && each.cwd === cwd);

        if (existing !== undefined) {
            if (existing.cols !== cols || existing.rows !== rows) {
                existing.cols = cols;
                existing.rows = rows;
                write(existing, { op: "resize", cols, rows });
            }

            return { terminal: summary(existing), frame: snapshot(existing) };
        }

        const live = [...terminals.values()].filter((each) => each.alive).length;

        if (live >= MAX_TERMINALS) {
            throw web.error(429, `That is ${MAX_TERMINALS} terminals at once. End one first.`);
        }

        const terminal = start(cwd, cols, rows);

        terminals.set(terminal.id, terminal);

        const timer = setTimeout(() => {
            if (!terminal.alive) terminals.delete(terminal.id);
        }, KEEP_ENDED_MS);

        timer.unref();

        return { terminal: summary(terminal), frame: snapshot(terminal) };
    });

    web.route("GET", "terminals/:id", (request) => {
        const terminal = find(request);

        return { terminal: summary(terminal), frame: snapshot(terminal) };
    });

    web.route("POST", "terminals/:id/input", (request) => {
        const terminal = find(request);

        write(terminal, {
            op: "input",
            text: typeof request.body.text === "string" ? request.body.text : undefined,
            keys: Array.isArray(request.body.keys) ? (request.body.keys as unknown[]).slice(0, 32) : undefined,
        });

        return { ok: true };
    });

    web.route("POST", "terminals/:id/paste", (request) => {
        const terminal = find(request);

        write(terminal, { op: "paste", text: typeof request.body.text === "string" ? request.body.text : "" });

        return { ok: true };
    });

    web.route("POST", "terminals/:id/focus", (request) => {
        const terminal = find(request);

        write(terminal, { op: "focus", inside: request.body.inside === true });

        return { ok: true };
    });

    /** The clipboard's text, for a program that asked for it: the page read it, and this is the answer to that ask. */
    web.route("POST", "terminals/:id/clipboard", (request) => {
        const terminal = find(request);

        write(terminal, {
            op: "clipboard",
            selection: typeof request.body.selection === "string" ? request.body.selection : "c",
            text: typeof request.body.text === "string" ? request.body.text : "",
        });

        return { ok: true };
    });

    web.route("POST", "terminals/:id/resize", (request) => {
        const terminal = find(request);
        const cols = size(request.body.cols, 20, 400, terminal.cols);
        const rows = size(request.body.rows, 5, 200, terminal.rows);

        if (cols !== terminal.cols || rows !== terminal.rows) {
            terminal.cols = cols;
            terminal.rows = rows;
            write(terminal, { op: "resize", cols, rows });
        }

        return { ok: true, cols, rows };
    });

    web.route("POST", "terminals/:id/scroll", (request) => {
        const terminal = find(request);
        const to =
            request.body.to === "bottom" || request.body.to === "top" ? request.body.to : Math.trunc(Number(request.body.lines)) || 0;

        write(terminal, { op: "scroll", to });

        return { ok: true };
    });

    web.route("DELETE", "terminals/:id", (request) => {
        const terminal = find(request);

        write(terminal, { op: "kill" });
        terminal.alive = false;
        terminal.proc.kill();
        terminals.delete(terminal.id);

        return { ok: true };
    });

    web.client("ghostty-terminal");

    web.onDispose(() => {
        for (const terminal of terminals.values()) {
            terminal.proc.kill();
        }

        terminals.clear();
    });
}

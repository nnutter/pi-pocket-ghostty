/**
 * The screen of one terminal: a grid of rows and runs that `ghostty-terminal.ts` sends, drawn as DOM, and a hidden
 * textarea that turns keystrokes into the key events that Ghostty's encoder reads.
 */

/** The bits of a run's `flags`, as `pty-host.ts` writes them. */
const BOLD = 1;
const FAINT = 2;
const ITALIC = 4;
const UNDERLINE = 8;
const STRIKE = 16;
const OVERLINE = 32;
const BLINK = 64;
const INVERSE = 128;
const INVISIBLE = 256;

/** The keys that go to the terminal as a key, not as the text that they would write. */
const KEYS_SENT_AS_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "Delete",
    "Enter",
    "NumpadEnter",
    "Tab",
    "Escape",
    "Backspace",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
]);

/** How a run's flags change the look of its text. */
function decoration(flags) {
    const lines = [];

    if (flags & UNDERLINE) lines.push("underline");
    if (flags & STRIKE) lines.push("line-through");
    if (flags & OVERLINE) lines.push("overline");

    return lines.join(" ");
}

/** One span of a row, reused from the frame before when the row keeps its shape. */
function paint(span, run) {
    const [text, fg, bg, flags] = run;

    if (span.textContent !== text) span.textContent = text;

    const style = span.style;

    style.color = fg;
    style.backgroundColor = bg;
    style.fontWeight = flags & BOLD ? "700" : "";
    style.fontStyle = flags & ITALIC ? "italic" : "";
    style.opacity = flags & FAINT ? "0.65" : "";
    style.textDecoration = decoration(flags);
    style.visibility = flags & INVISIBLE ? "hidden" : "";

    // Both colors are the theme's own: a swap is the theme's other end.
    const swapped = (flags & INVERSE) !== 0 && fg === "" && bg === "";

    if (span.classList.contains("gt-inverse") !== swapped) span.classList.toggle("gt-inverse", swapped);
}

/** A keydown as the key event that `libghostty-vt`'s encoder reads, or null for a key it does not know. */
function keyEventOf(event) {
    if (event.isComposing || event.key === "Dead" || event.key === "Process" || event.code === "") return null;

    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const key = {
        key: event.code || event.key,
        mods: {
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey,
            super: event.metaKey,
        },
    };

    if (printable) key.utf8 = event.key;

    return key;
}

export class TerminalView {
    #pocket;
    #container;
    #onState;
    #onClose;
    #fresh = false;
    #state = {};

    #screen = null;
    #grid = null;
    #cursorEl = null;
    #input = null;
    #font = 13;
    #cell = { width: 8, height: 17 };

    #id = null;
    #seq = null;
    #reading = false;
    #cols = 80;
    #rows = 24;
    #rowEls = [];
    #rowSpans = [];
    #stashed = new Map();
    #stops = [];
    #eventStops = [];
    #armed = { ctrl: false, shift: false, alt: false };
    #resting = 0;
    #keyboardTimer = null;
    #resizeTimer = null;
    #opening = false;
    #destroyed = false;
    #scrollTimer = null;
    #flashTimer = null;
    #bellTimer = null;
    #wheel = 0;
    #pendingScroll = 0;

    constructor(pocket, { container, onState, onClose, fresh }) {
        this.#pocket = pocket;
        this.#container = container;
        this.#onState = onState;
        this.#onClose = onClose;
        this.#fresh = fresh === true;
        this.#font = Number(globalThis.localStorage?.getItem("x.ghostty-terminal.font")) || 13;

        this.#build();
    }

    get font() {
        return this.#font;
    }

    #publish(patch) {
        this.#state = { ...this.#state, ...patch };
        this.#onState?.(this.#state);
    }

    /** The screen, the cursor, and the textarea that keeps the keys, once, for the life of the page. */
    #build() {
        const screen = document.createElement("div");

        // No tabindex: the textarea keeps the focus, so the browser never takes it away from a keystroke.
        screen.className = "gt-screen";
        screen.setAttribute("role", "group");
        screen.setAttribute("aria-label", "Terminal");

        const grid = document.createElement("div");

        grid.className = "gt-grid";
        screen.append(grid);

        const cursor = document.createElement("div");

        cursor.className = "gt-cursor";
        cursor.setAttribute("aria-hidden", "true");
        grid.append(cursor);

        const input = document.createElement("textarea");

        input.className = "gt-input";
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("aria-label", "Terminal keys");
        screen.append(input);

        this.#container.append(screen);
        this.#screen = screen;
        this.#grid = grid;
        this.#cursorEl = cursor;
        this.#input = input;

        this.#listen();
        this.#applyFont();
    }

    #listen() {
        const screen = this.#screen;
        const input = this.#input;

        const focus = () => input.focus({ preventScroll: true });

        // A tap or a click gives the keys to the terminal, unless the person dragged to select text.
        screen.addEventListener("pointerup", () => {
            if (globalThis.getSelection()?.toString()) return;

            focus();
        });
        screen.addEventListener("wheel", (event) => {
            event.preventDefault();

            this.#wheel += event.deltaY;

            const lines = Math.trunc(this.#wheel / this.#cell.height);

            if (lines === 0) return;

            this.#wheel -= lines * this.#cell.height;
            this.#scroll(lines);
        }, { passive: false });

        input.addEventListener("keydown", (event) => {
            const modified = event.ctrlKey || event.altKey || event.metaKey;
            const armed = this.#armedNow();

            // Ctrl+V and ⌘V paste through the browser, so the terminal gets the clipboard as text.
            if (!armed && (event.ctrlKey || event.metaKey) && event.code === "KeyV") return;

            if (!KEYS_SENT_AS_KEYS.has(event.code) && !modified && !armed) return;

            event.preventDefault();

            const key = keyEventOf(event);

            if (key === null) return;

            // A modifier that a key of the row armed is spent on this key, as a keyboard's own would be.
            if (armed) {
                this.#send({ keys: [{ ...key, mods: { ...key.mods, ...armed } }] });
                this.#disarm();
            } else {
                this.#send({ keys: [key] });
            }
        });

        input.addEventListener("input", () => {
            const text = input.value;

            input.value = "";

            if (text !== "") this.#send({ text });
        });

        input.addEventListener("paste", (event) => {
            const text = event.clipboardData?.getData("text");

            event.preventDefault();

            if (text) this.#paste(text);
        });

        input.addEventListener("focus", () => {
            screen.classList.add("gt-typing");
            this.#focus(true);

            // The keyboard takes its room a moment after the focus, so the check runs then as well as now.
            clearTimeout(this.#keyboardTimer);
            this.#checkKeyboard();
            this.#keyboardTimer = setTimeout(() => this.#checkKeyboard(), 400);
        });
        input.addEventListener("blur", () => {
            screen.classList.remove("gt-typing");
            this.#focus(false);
            clearTimeout(this.#keyboardTimer);
            this.#resting = window.innerHeight;
            this.#publish({ softKeyboard: false });
            this.#disarm();
        });

        const observer = new ResizeObserver(() => this.#measureSoon());

        observer.observe(screen);
        this.#stops.push(() => observer.disconnect());
        this.#watchKeyboard();
        this.#watchTab();
    }

    /** The keys that a soft keyboard has not got are worth a row above it, and only while it is there. */
    #watchKeyboard() {
        if (navigator.maxTouchPoints === 0) return;

        const remember = () => {
            if (!this.#focused()) this.#resting = window.innerHeight;
        };
        const onResize = () => {
            remember();
            this.#checkKeyboard();
        };
        // A listener is called with the window for `this`, so it goes through a function of the view's own.
        const check = () => this.#checkKeyboard();

        remember();

        window.addEventListener("resize", onResize);
        window.addEventListener("focus", check);
        window.visualViewport?.addEventListener("resize", check);

        this.#stops.push(() => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("focus", check);
            window.visualViewport?.removeEventListener("resize", check);
        });
    }

    /**
     * A hidden tab hears no events, and a tab that falls far behind is cut off with nothing kept for it, so the screen
     * is read again when the tab shows, and again after a while without a frame.
     */
    #watchTab() {
        const onShow = () => this.#onShow();

        document.addEventListener("visibilitychange", onShow);
        this.#stops.push(() => document.removeEventListener("visibilitychange", onShow));

        const idle = setInterval(() => {
            if (document.visibilityState === "visible") void this.#refresh();
        }, 15_000);

        this.#stops.push(() => clearInterval(idle));
    }

    #onShow() {
        if (document.visibilityState === "visible") void this.#refresh();
    }

    #applyFont() {
        this.#screen.style.setProperty("--gt-font", `${this.#font}px`);
        this.#screen.style.setProperty("--gt-line", `${Math.round(this.#font * 1.32)}px`);

        this.#measure();
    }

    /** The width of one character and the height of one line, as the browser draws them in this font. */
    #measure() {
        const probe = document.createElement("span");

        probe.className = "gt-probe";
        probe.textContent = "0123456789";
        this.#screen.append(probe);

        const width = probe.getBoundingClientRect().width / 10;

        probe.remove();

        const style = getComputedStyle(this.#screen);
        const height = parseFloat(style.lineHeight) || Math.round(this.#font * 1.32);

        this.#cell = { width: width > 0 ? width : this.#font * 0.6, height };
        this.#screen.style.setProperty("--gt-cell-w", `${this.#cell.width}px`);
        this.#screen.style.setProperty("--gt-cell-h", `${this.#cell.height}px`);
    }

    /** The columns and rows that fit the room that the page has now. */
    #fit() {
        const rect = this.#screen.getBoundingClientRect();
        const cols = Math.floor((rect.width - 2) / this.#cell.width);
        const rows = Math.floor((rect.height - 2) / this.#cell.height);

        return {
            cols: Math.max(20, Math.min(400, cols)),
            rows: Math.max(5, Math.min(200, rows)),
        };
    }

    #measureSoon() {
        if (this.#destroyed) return;

        clearTimeout(this.#resizeTimer);
        this.#resizeTimer = setTimeout(() => {
            const fit = this.#fit();

            if (this.#id === null || (fit.cols === this.#cols && fit.rows === this.#rows)) return;

            this.#pocket.api(`terminals/${this.#id}/resize`, fit).catch(() => {});
        }, 150);
    }

    /**
     * A key from the row above the keyboard: an arrow, an escape, a tab, or a character that is buried in a keyboard's
     * second page. A modifier that the row armed goes with it, so `Ctrl` then `←` is a word back in a shell.
     */
    press(key, text) {
        const armed = this.#armedNow();

        if (armed === null && text !== undefined) {
            this.#send({ text });
        } else {
            const mods = armed ?? {};
            const chars = text !== undefined && !mods.ctrl && !mods.alt;

            this.#send({ keys: [{ key, mods, ...(chars ? { utf8: text } : {}) }] });
        }

        this.#disarm();
    }

    /** Arms a modifier for the next key, or takes it back when it is already armed. */
    arm(name) {
        this.#armed = { ctrl: false, shift: false, alt: false, [name]: !this.#armed[name] };
        this.#publish({ armed: this.#armed });
    }

    /** The modifiers that the row armed, or null when none is. */
    #armedNow() {
        const on = Object.entries(this.#armed).filter(([, value]) => value).map(([name]) => name);

        return on.length === 0 ? null : Object.fromEntries(on.map((name) => [name, true]));
    }

    #disarm() {
        if (this.#armedNow() === null) return;

        this.#armed = { ctrl: false, shift: false, alt: false };
        this.#publish({ armed: this.#armed });
    }

    #focused() {
        return document.activeElement === this.#input;
    }

    /**
     * Whether a soft keyboard has the window, and so whether the row of keys that it has not got belongs above it.
     *
     * A keyboard either takes a keyboard's worth of height -- the drop from the window at rest -- or covers the window
     * without changing it, which is what a phone does. The third way is for a page that opens while the keyboard is
     * already up, when there is no drop to see: a window on a touch screen that is much shorter than the screen.
     */
    #checkKeyboard() {
        const viewport = window.visualViewport;
        const height = Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
        const dropped = this.#resting > 0 && height < this.#resting - 100;
        const covered = viewport !== undefined && viewport.height < window.innerHeight - 100;
        const cramped =
            globalThis.matchMedia("(pointer: coarse)").matches &&
            window.innerHeight < (globalThis.screen?.availHeight ?? window.innerHeight) * 0.72;

        this.#publish({ softKeyboard: this.#focused() && (dropped || covered || cramped) });
    }

    /** Puts the keyboard away: the row and the screen with it. */
    blur() {
        this.#input.blur();
    }

    /** A program rang the terminal's bell: a moment of light, as a terminal with a quiet bell does. */
    bell() {
        this.#screen.classList.remove("gt-bell");
        // A second bell in a row restarts the flash rather than sitting in it.
        void this.#screen.offsetWidth;
        this.#screen.classList.add("gt-bell");

        clearTimeout(this.#bellTimer);
        this.#bellTimer = setTimeout(() => this.#screen.classList.remove("gt-bell"), 140);
    }

    /** Takes the keys, as a pane beside another one does when a person moves to it. */
    focus() {
        this.#input.focus({ preventScroll: true });
    }

    /** Hands text to the browser's clipboard, as a program asked with OSC 52. */
    async #copy(text) {
        // The copy comes from a program, not from the person's own gesture, and a browser may sit on the question
        // of the clipboard for a long time: a fallback that answers now is better than a copy that waits.
        const written = await Promise.race([
            navigator.clipboard.writeText(text).then(
                () => true,
                () => false,
            ),
            new Promise((resolve) => setTimeout(() => resolve(false), 1200)),
        ]);

        let copied = written;

        if (!copied) {
            const holder = document.createElement("textarea");

            holder.value = text;
            holder.setAttribute("readonly", "true");
            holder.className = "gt-input";
            this.#screen.append(holder);
            holder.select();
            copied = document.execCommand("copy");
            holder.remove();
        }

        this.#flash(copied ? `Copied ${text.length} characters` : "Could not copy: the browser said no");
    }

    /** Reads the clipboard for a program that asked (OSC 52 with `?`), and answers with what it holds. */
    async #answer(selection) {
        let text = "";

        try {
            text = await navigator.clipboard.readText();
        } catch {
            this.#flash("Could not read the clipboard: the browser said no");
        }

        if (this.#id === null) return;

        await this.#pocket.api(`terminals/${this.#id}/clipboard`, { selection, text }).catch(() => {});
    }

    /** Says something in the bar for a moment: what the clipboard did, mostly. */
    #flash(message) {
        clearTimeout(this.#flashTimer);
        clearTimeout(this.#bellTimer);
        clearTimeout(this.#keyboardTimer);
        this.#publish({ flash: message });

        this.#flashTimer = setTimeout(() => {
            this.#flashTimer = null;
            this.#publish({ flash: null });
        }, 2500);
    }

    /** Text from a paste: the server wraps it when the program asked for a bracketed paste. */
    #paste(text) {
        if (this.#id === null || this.#destroyed) return;

        this.#pocket.api(`terminals/${this.#id}/paste`, { text }).catch(() => {});
    }

    /** Tells the program whether this terminal has the person's attention. */
    #focus(inside) {
        if (this.#id === null || this.#destroyed) return;

        this.#pocket.api(`terminals/${this.#id}/focus`, { inside }).catch(() => {});
    }

    /** Moves the view back through the scrollback: the lines of a wheel's turn, taken together, one call each 40 ms. */
    #scroll(lines) {
        if (this.#id === null || this.#destroyed) return;

        this.#pendingScroll += lines;
        clearTimeout(this.#scrollTimer);
        this.#scrollTimer = setTimeout(() => {
            const moves = this.#pendingScroll;

            this.#pendingScroll = 0;

            if (moves !== 0) this.#pocket.api(`terminals/${this.#id}/scroll`, { lines: moves }).catch(() => {});
        }, 40);
    }

    #send(body) {
        if (this.#id === null || this.#destroyed) return;

        this.#pocket.api(`terminals/${this.#id}/input`, body).catch(() => {});
    }

    /** Opens the terminal for the session that the tab shows, or takes the one that the folder already has. */
    async open() {
        if (this.#opening) return;

        this.#opening = true;
        this.#publish({ error: null });

        // Listen before the call: the first frames can come before the answer does.
        if (this.#eventStops.length === 0) this.#eventStops.push(
            this.#pocket.on("frame", ({ id, frame }) => {
                if (this.#id === null || id !== this.#id) {
                    this.#stashed.set(id, frame);
                    if (this.#stashed.size > 64) this.#stashed.delete(this.#stashed.keys().next().value);

                    return;
                }

                this.#apply(frame);
            }),
            this.#pocket.on("exit", ({ id, code, signal }) => {
                if (id !== this.#id) return;

                this.#publish({ alive: false, exitCode: code, signal });

                // A shell that ends well takes its window with it, as a terminal's own window does.
                if (code === 0) setTimeout(() => this.#onClose?.(), 250);
            }),
            this.#pocket.on("notice", ({ id, kind, message }) => {
                if (id !== this.#id) return;

                // A bell is not a thing to read: a shell rings one on every completion that found nothing.
                if (kind === "bell") {
                    this.bell();

                    return;
                }

                this.#publish({ notice: message });
            }),
            // A program in the terminal copied something: OSC 52, as Neovim's own clipboard provider sends it.
            this.#pocket.on("clipboard", ({ id, text }) => {
                if (id !== this.#id) return;

                void this.#copy(text);
            }),
            this.#pocket.on("clipboard-read", ({ id, selection }) => {
                if (id !== this.#id) return;

                void this.#answer(selection);
            }),
        );

        try {
            const answer = await this.#pocket.api("terminals", {
                // No session, no folder: the terminal starts in the person's home, as a new shell would.
                conversation: this.#pocket.conversationId() ?? undefined,
                // A pane beside another one has a shell of its own, even in the same folder.
                ...(this.#fresh ? { new: true } : {}),
                ...this.#fit(),
            }, { method: "POST" });

            // The pane went while its shell was starting: the shell is made, and has nowhere to be.
            if (this.#destroyed) {
                void this.#pocket.api(`terminals/${answer.terminal.id}`, undefined, { method: "DELETE" }).catch(() => {});

                return;
            }

            this.#id = answer.terminal.id;
            this.#apply(answer.frame);
            this.#publish({
                cwd: answer.terminal.cwd,
                alive: answer.terminal.alive,
                exitCode: answer.terminal.exitCode,
                signal: answer.terminal.signal,
            });

            for (const [id, frame] of this.#stashed) {
                if (id === this.#id) this.#apply(frame);
            }

            this.#stashed.clear();
            this.#input.focus({ preventScroll: true });
        } catch (error) {
            if (!this.#destroyed) this.#publish({ error: error.message });
        } finally {
            this.#opening = false;
        }
    }

    /** Reads the whole screen again, after a time when this tab heard no frames. */
    async #refresh() {
        if (this.#id === null || this.#reading || this.#destroyed) return;

        this.#reading = true;

        try {
            const answer = await this.#pocket.api(`terminals/${this.#id}`);

            if (answer.terminal.alive !== this.#state.alive) {
                this.#publish({
                    alive: answer.terminal.alive,
                    exitCode: answer.terminal.exitCode,
                    signal: answer.terminal.signal,
                });
            }

            this.#apply(answer.frame);
        } catch {
            // The terminal went while the tab was away: the next open makes a new one.
        } finally {
            this.#reading = false;
        }
    }

    /** Ends the shell and opens a new one in the same folder. */
    async restart() {
        const id = this.#id;

        this.#id = null;

        if (id !== null) {
            try {
                await this.#pocket.api(`terminals/${id}`, undefined, { method: "DELETE" });
            } catch (failure) {
                this.#publish({ error: failure.message });
                return;
            }
        }

        this.#rowEls = [];
        this.#rowSpans = [];
        this.#grid.querySelectorAll(".gt-row").forEach((row) => row.remove());
        this.#publish({ alive: true, exitCode: null, notice: null, error: null });

        await this.open();
    }

    /** Ends the shell and leaves the screen as it is. */
    async kill() {
        const id = this.#id;

        if (id === null) return;

        try {
            await this.#pocket.api(`terminals/${id}`, undefined, { method: "DELETE" });
        } catch (failure) {
            this.#publish({ error: failure.message });
        }
    }

    setFont(delta) {
        this.#font = Math.max(9, Math.min(22, this.#font + delta));
        globalThis.localStorage?.setItem("x.ghostty-terminal.font", String(this.#font));
        this.#applyFont();
        this.#resizeRows(this.#rows);
        this.#measureSoon();
    }

    /** Draws a frame: the rows that it names, then the cursor, the title, and the scroll position. */
    #apply(frame) {
        // A frame number that skips one means that a frame never arrived, and its rows were never drawn. The events of a
        // tab can be cut off when it is far behind, and a frame that the tab missed does not come again.
        if (this.#seq !== null && frame.seq > this.#seq + 1) this.#refresh();

        this.#seq = frame.seq;

        if (frame.full || frame.rows !== this.#rows) this.#resizeRows(frame.rows);

        this.#cols = frame.cols;
        this.#rows = frame.rows;

        const grid = this.#grid;

        grid.style.setProperty("--gt-cols", String(frame.cols));
        grid.style.setProperty("--gt-rows", String(frame.rows));

        for (const line of frame.lines) {
            const row = this.#rowEls[line.y];

            if (row === undefined) continue;

            const spans = this.#rowSpans[line.y] ?? [];
            const runs = line.runs;

            for (let i = 0; i < runs.length; i += 1) {
                let span = spans[i];

                if (span === undefined) {
                    span = document.createElement("span");
                    spans[i] = span;
                    row.append(span);
                }

                paint(span, runs[i]);
            }

            for (let i = runs.length; i < spans.length; i += 1) spans[i].remove();

            spans.length = runs.length;
            this.#rowSpans[line.y] = spans;
        }

        const cursor = this.#cursorEl;
        const shape = frame.cursor.shape ?? "block";
        const look = `${shape}${frame.cursor.blink ? " blink" : ""}`;

        cursor.style.transform = `translate(${frame.cursor.x * this.#cell.width}px, ${frame.cursor.y * this.#cell.height}px)`;
        cursor.style.opacity = frame.cursor.visible ? "1" : "0";

        if (cursor.dataset.look !== look) {
            cursor.dataset.look = look;
            cursor.classList.toggle("gt-cursor--bar", shape === "bar");
            cursor.classList.toggle("gt-cursor--underline", shape === "underline");
            cursor.classList.toggle("gt-cursor--blink", frame.cursor.blink === true);
        }

        if (frame.title !== this.#state.title) this.#publish({ title: frame.title });
    }

    /** Makes the grid have this many rows, as a new frame's size says. */
    #resizeRows(rows) {
        const grid = this.#grid;

        for (let y = 0; y < rows; y += 1) {
            if (this.#rowEls[y] !== undefined) continue;

            const row = document.createElement("div");

            row.className = "gt-row";
            grid.insertBefore(row, this.#cursorEl);
            this.#rowEls[y] = row;
        }

        while (this.#rowEls.length > rows) {
            this.#rowEls.pop()?.remove();
            this.#rowSpans.pop();
        }

        this.#rows = rows;
    }

    destroy() {
        this.#destroyed = true;
        clearTimeout(this.#resizeTimer);
        clearTimeout(this.#scrollTimer);
        clearTimeout(this.#flashTimer);
        clearTimeout(this.#bellTimer);
        clearTimeout(this.#keyboardTimer);

        for (const stop of [...this.#stops, ...this.#eventStops]) stop();

        this.#stops = [];
        this.#eventStops = [];
    }
}

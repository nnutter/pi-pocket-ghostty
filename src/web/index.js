// Ghostty terminal's browser module: a page on the rail, and a launcher action, that show one or more shells in the
// session's folder. `ghostty-terminal.ts` starts the pty of each pane and sends frames; `terminal.js` draws them.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

import { TerminalView } from "./terminal.js";

/** A prompt, as a 24×24 stroked path like the app's own icons. */
const PROMPT = "M5 7l4 4-4 4M12 16h7";

/** The way back to the keyboard, as a 24×24 stroked path. */
const KEYBOARD = "M3 14h18M3 10h18M6 18h12M6 6h12";

/**
 * The row above a phone's keyboard, in the order that a shell and an editor reach for it: the keys that a soft keyboard
 * has not got, then the arrows, then the characters that are a second page away on it. `[label, key, character?]`.
 */
const KEYS = [
    ["Esc", "Escape"],
    ["Tab", "Tab"],
    ["⇧", "Shift"],
    ["⌥", "Alt"],
    ["←", "ArrowLeft"],
    ["↓", "ArrowDown"],
    ["↑", "ArrowUp"],
    ["→", "ArrowRight"],
    ["Home", "Home"],
    ["End", "End"],
    ["PgUp", "PageUp"],
    ["PgDn", "PageDown"],
    ["/", "Slash", "/"],
    ["|", "Backslash", "|"],
    ["~", "Backquote", "~"],
    ["-", "Minus", "-"],
    ["_", "Minus", "_"],
    ["*", "Digit8", "*"],
];

/** A shell that ended well, or one that a person left with `exit`, says nothing: its page just goes. */
function endedQuietly(state) {
    return state.exitCode === 0 && !state.signal;
}

/** How a shell ended, as one value to compare: the code and the signal, whichever said so. */
function endedAs(state) {
    return `${state.exitCode ?? ""}:${state.signal ?? ""}`;
}

/** What to say about a shell that ended in a way worth a word. */
function saidOf(state) {
    if (state.signal) return `The shell was stopped (${state.signal}).`;
    if (state.exitCode === 130) return "The shell was interrupted.";
    if (state.exitCode === 143) return "The shell was stopped.";
    if (typeof state.exitCode === "number") return `The shell ended with code ${state.exitCode}.`;

    return "The shell ended.";
}

/** A leaf of the panes' tree: one shell. */
function leaf(key) {
    return { kind: "leaf", key };
}

/** Takes one pane out of the tree, and gives the other half of its split the room. */
function withoutLeaf(node, key) {
    if (node.kind === "leaf") return node.key === key ? null : node;

    const left = withoutLeaf(node.children[0], key);
    const right = withoutLeaf(node.children[1], key);

    if (left === null) return right;
    if (right === null) return left;

    return { ...node, children: [left, right] };
}

/** Puts a split where one pane was. A row is side by side; a column is one above the other. */
function splitLeaf(node, key, direction, added) {
    if (node.kind === "leaf") {
        return node.key === key ? { kind: "split", direction, children: [node, leaf(added)] } : node;
    }

    return { ...node, children: [splitLeaf(node.children[0], key, direction, added), splitLeaf(node.children[1], key, direction, added)] };
}

/** Every pane's share of the page, from 0 to 1 across and down, so that a key can tell which pane is where. */
function rectsOf(node, rect = { x: 0, y: 0, width: 1, height: 1 }, into = new Map()) {
    if (node.kind === "leaf") {
        into.set(node.key, rect);

        return into;
    }

    const half = node.direction === "row" ? rect.width / 2 : rect.height / 2;
    const first = node.direction === "row" ? { ...rect, width: half } : { ...rect, height: half };
    const second =
        node.direction === "row"
            ? { ...rect, x: rect.x + half, width: half }
            : { ...rect, y: rect.y + half, height: half };

    rectsOf(node.children[0], first, into);
    rectsOf(node.children[1], second, into);

    return into;
}

/** The pane in a direction from the focused one, as a terminal of Ghostty's splits would go. */
function neighbour(tree, focused, direction) {
    const rects = rectsOf(tree);
    const from = rects.get(focused);

    if (from === undefined) return null;

    const centre = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    let best = null;
    let bestDistance = Infinity;

    for (const [key, rect] of rects) {
        if (key === focused) continue;

        const other = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const across = other.x - centre.x;
        const down = other.y - centre.y;

        const ahead =
            (direction === "left" && across < 0) ||
            (direction === "right" && across > 0) ||
            (direction === "up" && down < 0) ||
            (direction === "down" && down > 0);

        if (!ahead) continue;

        // The straightest way wins: a pane beside the focused one beats one that is mostly above it.
        const distance =
            direction === "left" || direction === "right" ? Math.abs(across) + Math.abs(down) * 3 : Math.abs(down) + Math.abs(across) * 3;

        if (distance < bestDistance) {
            bestDistance = distance;
            best = key;
        }
    }

    return best;
}

/** One pane: a screen of its own, and the keys that go in it, in the share of the page that the tree gives it. */
function Pane({ paneKey, api, focused, rect }) {
    const { html, useEffect, useRef } = api.pocket;
    const box = useRef(null);

    useEffect(() => {
        const made = new TerminalView(api.pocket, {
            container: box.current,
            onState: (state) => api.said(paneKey, state),
            onClose: () => api.ended(paneKey),
            fresh: api.fresh(paneKey),
        });

        api.views.set(paneKey, made);
        made.open().catch(() => {});

        return () => {
            api.views.delete(paneKey);
            made.destroy();
        };
    }, []);

    const place = `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.width * 100}%;height:${rect.height * 100}%`;

    return html`<div
        class="gt-pane ${focused ? "is-focused" : ""}"
        style=${place}
        onPointerDown=${() => api.shown(paneKey)}
    >
        <div class="gt-view" ref=${box}></div>
    </div>`;
}

function TerminalPage({ pocket, close, setOpen }) {
    const { html, useEffect, useRef, useState } = pocket;

    const [tree, setTree] = useState(leaf("pane-1"));
    const [focused, setFocused] = useState("pane-1");
    const [states, setStates] = useState({});
    const [dismissed, setDismissed] = useState(null);
    const views = useRef(new Map());
    const next = useRef(2);
    // The panes that have had the keys, newest last: a pane that goes gives them back to the one before it.
    const history = useRef(["pane-1"]);

    const state = states[focused] ?? {};
    const armed = state.armed ?? {};

    // What a pane can do to the page, kept in one object so that a pane never remounts when the page draws again.
    const api = useRef(null);

    if (api.current === null) {
        api.current = {
            pocket,
            views: views.current,
            said: (key, said) => setStates((all) => ({ ...all, [key]: said })),
            shown: (key) => focusPane(key),
            ended: (key) => closePane(key),
            fresh: (key) => key !== "pane-1",
        };
    }

    const view = () => views.current.get(focused);

    /** Gives the keys to a pane, and remembers the way back to the one that had them. */
    const focusPane = (key) => {
        if (key !== focused) history.current = [...history.current.filter((each) => each !== key), key];
        setFocused(key);
    };

    const closePane = (key) => {
        const made = views.current.get(key);

        if ((states[key]?.alive ?? true) === true) void made?.kill();

        // The pane's keys are taken before its box goes, so that the focus that a removed textarea loses is not sent
        // to a shell that is on its way out.
        made?.destroy();

        const left = withoutLeaf(tree, key);

        // The last pane takes the page with it, as a window with one shell in it does.
        if (left === null) {
            close();

            return;
        }

        setTree(left);
        setStates((all) => {
            const copy = { ...all };
            delete copy[key];

            return copy;
        });

        // The keys go back to the pane that had them before this one, which is the pane that it was split from.
        const open = new Set(rectsOf(left).keys());

        history.current = history.current.filter((each) => each !== key && open.has(each));

        if (key === focused) setFocused(history.current.at(-1) ?? [...open][0] ?? "pane-1");
    };

    const closePaneNow = useRef(closePane);

    closePaneNow.current = closePane;

    const split = (direction) => {
        if ([...rectsOf(tree).keys()].length >= 8) return;

        const key = `pane-${next.current}`;

        next.current += 1;
        setTree((current) => splitLeaf(current, focused, direction, key));
        focusPane(key);
    };

    const restart = () => void view()?.restart();
    const end = () => void view()?.kill();

    useEffect(() => {
        setOpen(true);

        return () => {
            setOpen(false);

            // The page is the window of these shells: the one that a person comes back to keeps running, and a pane
            // that would show nowhere ends with it.
            for (const [key, made] of views.current) {
                if (key !== "pane-1") made.kill();
            }
        };
    }, []);

    // Ghostty's own keys for its splits, where a browser leaves them to the page.
    useEffect(() => {
        const onKey = (event) => {
            const mod = event.ctrlKey || event.metaKey;
            const key = event.code;

            if (mod && event.shiftKey && key === "KeyD") {
                event.preventDefault();
                event.stopPropagation();
                split("row");
            } else if (mod && event.shiftKey && key === "KeyE") {
                event.preventDefault();
                event.stopPropagation();
                split("column");
            } else if (mod && event.shiftKey && key === "KeyX") {
                event.preventDefault();
                event.stopPropagation();
                closePaneNow.current(focused);
            } else if (event.altKey && !mod && key.startsWith("Arrow")) {
                const way = key.slice(5).toLowerCase();
                const to = neighbour(tree, focused, way);

                if (to !== null) {
                    event.preventDefault();
                    event.stopPropagation();
                    focusPane(to);
                    views.current.get(to)?.focus();
                }
            }
        };

        window.addEventListener("keydown", onKey, true);

        return () => window.removeEventListener("keydown", onKey, true);
    }, [tree, focused]);

    const press = (key, text) => (event) => {
        event.preventDefault();
        view()?.press(key, text);
    };

    const arm = (name) => (event) => {
        event.preventDefault();
        view()?.arm(name);
    };

    const name = state.title || (state.cwd ? state.cwd.split("/").filter(Boolean).at(-1) : "Terminal");
    const panes = [...rectsOf(tree).keys()].length;

    return html`<div class="gt-page">
        <div class="gt-bar">
            <div class="gt-name" title=${state.cwd ?? ""}>
                <span class="gt-title">${name}</span>
                ${state.cwd ? html`<span class="gt-cwd small muted">${state.cwd}</span>` : null}
            </div>
            ${state.flash ? html`<span class="gt-flash small muted">${state.flash}</span>` : null}
            <div class="gt-actions">
                <button
                    class="button gt-small"
                    title="A pane to the right (Control+Shift+D)"
                    onClick=${() => split("row")}
                >
                    ◫
                </button>
                <button class="button gt-small" title="A pane below (Control+Shift+E)" onClick=${() => split("column")}>
                    ⬓
                </button>
                ${panes > 1
                    ? html`<button class="button gt-small" title="Close this pane (Control+Shift+X)" onClick=${() => closePane(focused)}>
                          ✕
                      </button>`
                    : null}
                <button class="button gt-small" title="Smaller text" onClick=${() => view()?.setFont(-1)}>A−</button>
                <button class="button gt-small" title="Larger text" onClick=${() => view()?.setFont(1)}>A+</button>
                <button class="button gt-small" onClick=${restart}>New shell</button>
                <button class="button gt-small" onClick=${end}>End</button>
            </div>
        </div>
        <div class="gt-panes">
            ${[...rectsOf(tree)].map(
                ([key, rect]) =>
                    html`<${Pane} key=${key} paneKey=${key} rect=${rect} api=${api.current} focused=${focused === key} />`,
            )}
            ${state.error
                ? html`<div class="gt-note">
                      <span class="error-box">${state.error}</span>
                      <button class="button gt-small" onClick=${() => void view()?.open()}>Try again</button>
                  </div>`
                : null}
            ${state.alive === false && !endedQuietly(state) && dismissed !== endedAs(state)
                ? html`<div class="gt-note">
                      <span class="gt-note-said">${saidOf(state)}</span>
                      <button class="button gt-small" onClick=${restart}>New shell</button>
                      <button class="button gt-small" onClick=${() => closePane(focused)}>Close pane</button>
                      <button
                          class="button gt-small gt-note-x"
                          title="Put this away"
                          aria-label="Put this away"
                          onClick=${() => setDismissed(endedAs(state))}
                      >
                          ×
                      </button>
                  </div>`
                : null}
            ${state.notice ? html`<div class="gt-note muted small">${state.notice}</div>` : null}
        </div>
        ${state.softKeyboard
            ? html`<div class="gt-keys">
                  <button
                      class="gt-key gt-round ${armed.ctrl ? "gt-key-on" : ""}"
                      aria-pressed=${armed.ctrl ? "true" : "false"}
                      title="Control, for the next key"
                      onPointerDown=${arm("ctrl")}
                      onClick=${(event) => event.preventDefault()}
                  >
                      ⌃
                  </button>
                  <div class="gt-keyrow">
                      ${KEYS.map(
                          ([label, key, text]) =>
                              html`<button
                                  class="gt-key ${armed[key.toLowerCase()] && (key === "Shift" || key === "Alt") ? "gt-key-on" : ""}"
                                  title=${label}
                                  onPointerDown=${key === "Shift" || key === "Alt" ? arm(key.toLowerCase()) : press(key, text)}
                                  onClick=${(event) => event.preventDefault()}
                              >
                                  ${label}
                              </button>`,
                      )}
                  </div>
                  <button
                      class="gt-key gt-round"
                      title="Put the keyboard away"
                      onPointerDown=${(event) => {
                          event.preventDefault();
                          view()?.blur();
                      }}
                      onClick=${(event) => event.preventDefault()}
                  >
                      <${pocket.Icon} path=${KEYBOARD} size=${18} />
                  </button>
              </div>`
            : null}
    </div>`;
}

export default function setup(pocket) {
    const { html } = pocket;

    // Whether the page shows: the one key that opens it is the one that puts it away.
    let open = false;
    const setOpen = (value) => {
        open = value;
    };

    function Page() {
        return html`<${TerminalPage} pocket=${pocket} close=${() => pocket.closePage()} setOpen=${setOpen} />`;
    }

    pocket.style("terminal.css");
    // Esc belongs to the terminal: it leaves an editor's insert mode, and it is half of what a shell's prompt reads.
    // The page's own close button and Back still close it.
    pocket.page({ id: "terminal", title: "Terminal", component: Page, escape: false, swipe: false });
    pocket.rail({ id: "terminal", title: "Terminal", iconPath: PROMPT, page: "terminal" });
    pocket.launcher({
        id: "terminal",
        label: "Terminal",
        detail: "a shell in this session's folder",
        iconPath: PROMPT,
        page: "terminal",
    });

    // A terminal that opens and closes on one key is a terminal that is beside the work rather than in the way.
    const onKey = (event) => {
        const mod = event.ctrlKey || event.metaKey;

        if (!mod || event.shiftKey || event.altKey || event.code !== "Backquote") return;

        event.preventDefault();
        event.stopPropagation();

        if (open) pocket.closePage();
        else pocket.openPage("terminal");
    };

    document.addEventListener("keydown", onKey, true);
    pocket.onDispose(() => document.removeEventListener("keydown", onKey, true));
}

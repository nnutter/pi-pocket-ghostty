// Ghostty terminal's browser module: a page on the rail, and a launcher action, that show one or more shells in the
// session's folder. `ghostty-terminal.ts` starts the pty of each pane and sends frames; `terminal.js` draws them.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

import { TerminalView, keyboardShown, restingHeight } from "./terminal.js";

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

/**
 * Whether a soft keyboard has the window, and so whether the row of keys that it has not got belongs above it.
 *
 * A keyboard either takes a keyboard's worth of height -- the drop from the window at rest -- or covers the window
 * without changing it, which is what a phone does. The third way is for a page that opens while the keyboard is already
 * up, when there is no drop to see: a window on a touch screen that is much shorter than the screen.
 *
 * The page answers this for all of its panes at once. A pane of its own answering would take the row away for the moment
 * of every switch between panes, which is a flicker over a keyboard that never moved.
 */
function useSoftKeyboard(pocket) {
    const { useEffect, useRef, useState } = pocket;
    const [up, setUp] = useState(false);
    const resting = useRef(0);
    const wasUp = useRef(false);

    useEffect(() => {
        if (navigator.maxTouchPoints === 0) return;

        const typing = () => document.activeElement?.classList.contains("gt-input") === true;

        const width = { current: window.innerWidth };

        const check = () => {
            const viewport = window.visualViewport;

            const up = keyboardShown({
                height: Math.min(window.innerHeight, viewport?.height ?? window.innerHeight),
                rest: resting.current,
                viewportHeight: viewport?.height,
                innerHeight: window.innerHeight,
                availHeight: globalThis.screen?.availHeight,
                coarse: globalThis.matchMedia("(pointer: coarse)").matches,
                typing: typing(),
                wasUp: wasUp.current,
            });

            wasUp.current = up;
            setUp(up);
        };

        const remember = () => {
            resting.current = restingHeight(resting.current, {
                height: window.innerHeight,
                width: window.innerWidth,
                lastWidth: width.current,
                typing: typing(),
            });
            width.current = window.innerWidth;
        };

        const onResize = () => {
            remember();
            check();
        };
        const onFocusOut = () => setTimeout(check, 0);

        resting.current = window.innerHeight;

        window.addEventListener("resize", onResize);
        window.visualViewport?.addEventListener("resize", check);
        document.addEventListener("focusin", check);
        document.addEventListener("focusout", onFocusOut);

        return () => {
            window.removeEventListener("resize", onResize);
            window.visualViewport?.removeEventListener("resize", check);
            document.removeEventListener("focusin", check);
            document.removeEventListener("focusout", onFocusOut);
        };
    }, []);

    /** Puts the row away because a person did, whatever the window is still measuring. */
    const away = () => {
        wasUp.current = false;
        setUp(false);
    };

    return [up, away];
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
            keyboardUp: () => api.keyboardUp(),
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
    const [keyboard, putRowAway] = useSoftKeyboard(pocket);
    const views = useRef(new Map());
    const keyboardRef = useRef(false);
    // The pane that closes a pane, through a ref: a pane's own end is asked of the tree that a person has now, and not
    // of the tree that the first drawing of the page was made with.
    const closePaneNow = useRef(null);
    const next = useRef(2);
    // The panes that have had the keys, newest last: a pane that goes gives them back to the one before it.
    const history = useRef(["pane-1"]);

    const state = states[focused] ?? {};
    const armed = state.armed ?? {};

    keyboardRef.current = keyboard;

    // What a pane can do to the page, kept in one object so that a pane never remounts when the page draws again.
    const api = useRef(null);

    if (api.current === null) {
        api.current = {
            pocket,
            views: views.current,
            said: (key, said) => setStates((all) => ({ ...all, [key]: said })),
            shown: (key) => focusPane(key),
            ended: (key) => closePaneNow.current?.(key),
            fresh: (key) => key !== "pane-1",
            keyboardUp: () => keyboardRef.current,
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


    closePaneNow.current = closePane;

    const split = (direction) => {
        if ([...rectsOf(tree).keys()].length >= 8) return;

        const key = `pane-${next.current}`;

        next.current += 1;

        // The keys leave this pane for the new one, which is not a pane to take them back to.
        views.current.get(focused)?.releaseKeys();

        setTree((current) => splitLeaf(current, focused, direction, key));
        focusPane(key);

        // The pane is drawn after this, so its keys are asked for once it is there: a keyboard that was up stays up
        // only for an input that is on the page.
        for (const wait of [0, 60, 200]) {
            setTimeout(() => views.current.get(key)?.focus(), wait);
        }
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

                    views.current.get(focused)?.releaseKeys();
                    focusPane(to);
                    views.current.get(to)?.focus();
                }
            }
        };

        window.addEventListener("keydown", onKey, true);

        return () => window.removeEventListener("keydown", onKey, true);
    }, [tree, focused]);

    /**
     * A key of the row, or a button of the bar, is pressed without taking the focus, so that the keyboard stays up
     * under it.
     *
     * A browser moves the focus to the button that is tapped, and a system that has the keyboard takes the keyboard
     * away with the focus. So the tap's own action is stopped, on the touch as well as on the press -- which also stops
     * the click that would have come after it -- and the keys are asked back inside the tap, the one moment when a page
     * may ask for them.
     *
     * The stopping is why the action runs on whichever of the press and the click comes first, once: a tap sends both,
     * and a key of a keyboard that a person pressed sends only the click.
     */
    const keep = (event) => {
        if (event.cancelable) event.preventDefault();
    };

    // When the last press happened, for the whole page: a click that follows a press belongs to that press, and the page
    // may well have drawn itself again between the two, which is a new handler with a new memory of its own.
    const pressedAt = useRef(0);

    const once = (run) => (event) => {
        keep(event);

        const now = Date.now();

        if (event.type === "click" && now - pressedAt.current < 700) return;
        if (event.type === "pointerdown") pressedAt.current = now;

        view()?.keepKeys();
        run();
        view()?.focus();
        setTimeout(() => view()?.focus(), 0);
    };

    /** The bar's own buttons act on the terminal too: a tap on one of them holds the keys rather than leaving them. */
    /** An octicon: a 16 by 16 drawing, in one shape or a few, that takes the button's color and the size of its letters. */
    const icon = (...shapes) =>
        html`<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            ${shapes.map((shape) => html`<path d=${shape} />`)}
        </svg>`;

    // The frame of a box: a square outline whose corners are rounded a little, filled the width of a line of the drawing.
    const FRAME =
        "M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm10.5 1.5H2.75a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Z";

    const PLUS = "M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4Z";
    // A glass with a minus in it, and one with a plus: the letters' size, smaller or larger.
    const MINUS =
        "M4.5 6.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1 0-1.5Z";
    const GLASS_UNDER =
        "M0 7.5a7.5 7.5 0 1 1 13.307 4.747l2.473 2.473a.749.749 0 1 1-1.06 1.06l-2.473-2.473A7.5 7.5 0 0 1 0 7.5Zm7.5-6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z";
    const OVER_PLUS =
        "M3.75 7.5a.75.75 0 0 1 .75-.75h2.25V4.5a.75.75 0 0 1 1.5 0v2.25h2.25a.75.75 0 0 1 0 1.5H8.25v2.25a.75.75 0 0 1-1.5 0V8.25H4.5a.75.75 0 0 1-.75-.75Z";
    const GLASS_OVER =
        "M7.5 0a7.5 7.5 0 0 1 5.807 12.247l2.473 2.473a.749.749 0 1 1-1.06 1.06l-2.473-2.473A7.5 7.5 0 1 1 7.5 0Zm-6 7.5a6 6 0 1 0 12 0 6 6 0 0 0-12 0Z";

    // Two panes, and the line that the split makes between them: across, or down.
    const DOWN = "M7.25 2.25h1.5v11.5h-1.5z";
    const ACROSS = "M2.25 7.25h11.5v1.5h-11.5z";
    const END =
        "M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z";

    const button = (label, title, run, extra = "") => {
        // One press, one action: the press and the click that may follow it share the one guard.
        const go = once(run);

        return html`<button
            class="button gt-small ${extra}"
            title=${title}
            aria-label=${title === "" ? undefined : title}
            onPointerDown=${go}
            onClick=${go}
        >
            ${label}
        </button>`;
    };

    const press = (key, text) =>
        once(() => {
            view()?.press(key, text);
        });

    const arm = (name) =>
        once(() => {
            view()?.arm(name);
        });

    // The round Control of the row, and the round key that puts the keyboard away, which asks for nothing back.
    const ctrl = arm("ctrl");

    const away = (event) => {
        keep(event);
        view()?.blur();
        putRowAway();
    };

    const panes = [...rectsOf(tree).keys()].length;

    return html`<div class="gt-page">
        <div class="gt-bar">
            ${state.flash ? html`<span class="gt-flash small muted">${state.flash}</span>` : null}
            <div class="gt-actions">
                ${button(icon(FRAME, PLUS), "New shell", restart, "gt-restart")}
                <span class="gt-space"></span>
                ${button(icon(FRAME, DOWN), "A pane to the right (Control+Shift+D)", () => split("row"), "gt-split")}
                ${button(icon(FRAME, ACROSS), "A pane below (Control+Shift+E)", () => split("column"), "gt-split")}
                ${panes > 1 ? button("✕", "Close this pane (Control+Shift+X)", () => closePane(focused), "gt-close") : null}
            </div>
            <div class="gt-actions">
                ${button(icon(MINUS, GLASS_UNDER), "Smaller text", () => view()?.setFont(-1), "gt-font")}
                ${button(icon(OVER_PLUS, GLASS_OVER), "Larger text", () => view()?.setFont(1), "gt-font")}
                <span class="gt-space"></span>
                ${button(icon(END), "End", end, "gt-end")}
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
        ${keyboard
            ? html`<div class="gt-keys">
                  <button
                      class="gt-key gt-round ${armed.ctrl ? "gt-key-on" : ""}"
                      aria-pressed=${armed.ctrl ? "true" : "false"}
                      title="Control, for the next key"
                      onPointerDown=${ctrl}
                      onClick=${ctrl}
                  >
                      ⌃
                  </button>
                  <div class="gt-keyrow">
                      ${KEYS.map(([label, key, text]) => {
                          const run = key === "Shift" || key === "Alt" ? arm(key.toLowerCase()) : press(key, text);

                          return html`<button
                                  class="gt-key ${armed[key.toLowerCase()] && (key === "Shift" || key === "Alt") ? "gt-key-on" : ""}"
                                  title=${label}
                                  onPointerDown=${run}
                                  onClick=${run}
                              >
                                  ${label}
                              </button>`;
                      })}
                  </div>
                  <button
                      class="gt-key gt-round"
                      title="Put the keyboard away"
                      onPointerDown=${away}
                      onClick=${away}
                  >
                      <${pocket.Icon} path=${KEYBOARD} size=${18} />
                  </button>
              </div>`
            : null}
    </div>`;
}

export default function setup(pocket) {
    const { html } = pocket;

    // Whether the terminal shows: the one key that opens it is the one that puts it away.
    let open = false;
    const setOpen = (value) => {
        open = value;
    };

    function Page({ close }) {
        return html`<${TerminalPage} pocket=${pocket} close=${close} setOpen=${setOpen} />`;
    }

    // A terminal belongs to the session that it works in, so it docks beside that session's conversation where the
    // Browser and Files panels dock, and takes a tile in the places. A panel came in 0.19.0: an older app gets the page
    // and a button on the rail instead.
    const panels = typeof pocket.panel === "function";

    pocket.style("terminal.css");

    if (panels) {
        pocket.panel({ id: "terminal", title: "Terminal", component: Page, iconPath: PROMPT, wide: true });
        pocket.launcher({
            id: "terminal",
            label: "Terminal",
            detail: "a shell in this session's folder",
            iconPath: PROMPT,
            panel: "terminal",
        });
    } else {
        // Esc belongs to the terminal: it leaves an editor's insert mode, and it is half of what a shell reads.
        pocket.page({ id: "terminal", title: "Terminal", component: Page, escape: false, swipe: false });
        pocket.rail({ id: "terminal", title: "Terminal", iconPath: PROMPT, page: "terminal" });
        pocket.launcher({
            id: "terminal",
            label: "Terminal",
            detail: "a shell in this session's folder",
            iconPath: PROMPT,
            page: "terminal",
        });
    }

    // A terminal that opens and closes on one key is a terminal that is beside the work rather than in the way.
    const onKey = (event) => {
        const mod = event.ctrlKey || event.metaKey;

        if (!mod || event.shiftKey || event.altKey || event.code !== "Backquote") return;

        event.preventDefault();
        event.stopPropagation();

        if (!open) {
            if (panels) pocket.openPanel("terminal");
            else pocket.openPage("terminal");
        } else if (panels) {
            pocket.closePanel();
        } else {
            pocket.closePage();
        }
    };

    document.addEventListener("keydown", onKey, true);
    pocket.onDispose(() => document.removeEventListener("keydown", onKey, true));
}

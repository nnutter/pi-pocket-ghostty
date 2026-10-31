/**
 * A browser, a real shell, and the page that a person uses: the tests here drive the module's own page in Chromium,
 * with touch where a phone has it, and hold it to the behaviour that the last few changes broke.
 *
 * The page comes from `scripts/preview.ts`, which serves the browser module and the module's routes. Nothing here is a
 * mock: a tap is a tap, a keyboard is a viewport that lost a keyboard's worth of height, and a pane is a pty.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const PORT = Number(process.env.GHOSTTY_TEST_PORT ?? 4719);
const URL_BASE = `http://127.0.0.1:${PORT}`;

let server: Bun.Subprocess<"ignore", "ignore", "inherit">;
let browser: Browser;

/** The Chromium on this machine: the one that Pi Pocket uses for its browser, or one of the usual names. */
function chromePath(): string {
    const named = process.env.CHROME_PATH;

    if (named !== undefined) return named;

    for (const candidate of [
        "/opt/chromium/1731015/chrome-linux/chrome",
        "/opt/chromium/1731004/chrome-linux/chrome",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
    ]) {
        if (Bun.file(candidate).size > 0) return candidate;
    }

    throw new Error("No Chromium found: set CHROME_PATH to one.");
}

beforeAll(async () => {
    server = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "scripts", "preview.ts")], {
        env: { ...process.env, PORT: String(PORT) },
        stdout: "ignore",
        stderr: "inherit",
    });

    const deadline = Date.now() + 20_000;

    for (;;) {
        try {
            const answer = await fetch(`${URL_BASE}/api/terminals`);

            if (answer.ok) break;
        } catch {
            // Not up yet.
        }

        if (Date.now() > deadline) throw new Error("The preview server did not start.");
        await Bun.sleep(100);
    }

    browser = await puppeteer.launch({
        executablePath: chromePath(),
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
}, 40_000);

afterAll(async () => {
    await browser?.close();
    server?.kill();
});

/** A phone: a narrow window, a touch screen, and a page that has not lost any height yet. */
async function openPhone(): Promise<Page> {
    const page = await browser.newPage();

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-pane .gt-row");
    await settle(page, 400);

    return page;
}

/** A panel in a window wide enough for every button of the bar. */
async function openWide(): Promise<Page> {
    const page = await browser.newPage();

    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 2 });
    await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".gt-pane .gt-row");
    await settle(page, 400);

    return page;
}

/** Waits for the page to finish what a tap or a keystroke set going. */
function settle(page: Page, ms = 250): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The keys arrive, and the keyboard with them: a phone takes a keyboard's worth of the window. */
async function keyboardUp(page: Page): Promise<void> {
    await tap(page, ".gt-screen");
    await page.setViewport({ width: 390, height: 520, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await settle(page, 400);
}

async function keyboardDown(page: Page): Promise<void> {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await settle(page, 400);
}

/** A finger on an element: a touch, as a phone sends one. */
async function tap(page: Page, selector: string): Promise<void> {
    const element = await page.$(selector);

    if (element === null) throw new Error(`Nothing on the page is ${selector}`);

    const box = await element.boundingBox();

    if (box === null) throw new Error(`${selector} has no box`);

    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page);
}

/** The key of the row whose label is this one. */
async function tapKey(page: Page, label: string): Promise<void> {
    const labels = await page.$$eval(".gt-key", (keys) => keys.map((key) => key.textContent?.trim() ?? ""));
    const at = labels.indexOf(label);

    if (at < 0) throw new Error(`No key ${label} in the row: ${labels.join(" ")}`);

    await tap(page, `.gt-key:nth-of-type(${at + 1})`).catch(async () => {
        // The row's keys are not all direct children of one element: tap by index of the whole set.
        const keys = await page.$$(".gt-key");

        await keys[at]!.tap();
        await settle(page);
    });
}

const rowShown = (page: Page) => page.$(".gt-keys").then((found) => found !== null);
const panes = (page: Page) => page.$$(".gt-pane").then((found) => found.length);
const focusedPane = (page: Page) =>
    page.$$eval(".gt-pane", (all) => all.findIndex((pane) => pane.classList.contains("is-focused")));
const focusedThing = (page: Page) => page.evaluate(() => document.activeElement?.className ?? "(none)");
const armed = (page: Page) =>
    page.$eval(".gt-key.gt-round", (key) => key.className.includes("gt-key-on")).catch(() => false);

describe("the row above a soft keyboard", () => {
    test("comes up with the keyboard, and stays while the keyboard has the room", async () => {
        const page = await openPhone();

        try {
            expect(await rowShown(page)).toBe(false);

            await keyboardUp(page);

            expect(await rowShown(page)).toBe(true);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("stays when the keys leave the terminal for a moment, and the window resizes", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            expect(await rowShown(page)).toBe(true);

            // The keys leave for a button, and the window tells the page that it changed size, as an iPad's does.
            await page.evaluate(() => {
                (document.activeElement as HTMLElement | null)?.blur();
                window.dispatchEvent(new Event("resize"));
            });
            await settle(page, 300);

            expect(await rowShown(page)).toBe(true);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("goes when the keyboard's room comes back", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            expect(await rowShown(page)).toBe(true);

            await keyboardDown(page);

            expect(await rowShown(page)).toBe(false);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("Control and the keys of the row", () => {
    test("tapping Control arms it once, keeps the row, and keeps the keys", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            await tapKey(page, "⌃");

            expect(await rowShown(page)).toBe(true);
            expect(await armed(page)).toBe(true);
            expect(await focusedThing(page)).toBe("gt-input");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("Control and then a typed key sends that key with Control", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            await tapKey(page, "⌃");

            const sent = await page.evaluate(async () => {
                const seen: unknown[] = [];
                const original = window.fetch.bind(window);

                window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
                    if (String(input).includes("/input")) seen.push(JSON.parse(String(init?.body)));

                    return original(input, init);
                }) as typeof fetch;

                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
                await new Promise((resolve) => setTimeout(resolve, 300));
                window.fetch = original;

                return seen;
            });

            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ keys: [{ key: "KeyA", mods: { ctrl: true } }] });
            expect(await armed(page)).toBe(false);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a key of the row keeps the keys, so the keyboard stays up", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);

            for (const label of ["Esc", "Tab", "←", "/"]) {
                await tapKey(page, label);

                expect(await focusedThing(page)).toBe("gt-input");
            }
        } finally {
            await page.close();
        }
    }, 30_000);

    test("the key that puts the keyboard away puts it away, and it stays away", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);

            const away = await page.$$(".gt-key.gt-round");

            await away.at(-1)!.tap();
            await settle(page, 600);

            expect(await rowShown(page)).toBe(false);
            expect(await focusedThing(page)).not.toBe("gt-input");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("panes", () => {
    test("a tap on a split makes one pane, puts the keys in it, and keeps the keyboard", async () => {
        const page = await openPhone();

        try {
            await keyboardUp(page);
            await tap(page, ".gt-split");

            expect(await panes(page)).toBe(2);
            expect(await focusedPane(page)).toBe(1);
            expect(await focusedThing(page)).toBe("gt-input");
            expect(await rowShown(page)).toBe(true);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a pane below, and a pane closed, from the keys", async () => {
        const page = await openPhone();

        try {
            await page.keyboard.down("Control");
            await page.keyboard.down("Shift");
            await page.keyboard.press("KeyD");
            await page.keyboard.press("KeyE");
            await page.keyboard.up("Shift");
            await page.keyboard.up("Control");
            await settle(page, 1200);

            expect(await panes(page)).toBe(3);

            await page.keyboard.down("Control");
            await page.keyboard.down("Shift");
            await page.keyboard.press("KeyX");
            await page.keyboard.up("Shift");
            await page.keyboard.up("Control");
            await settle(page, 900);

            expect(await panes(page)).toBe(2);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("a shell that ends in the third pane leaves the other two", async () => {
        const page = await openPhone();

        try {
            // Three panes, the third split from the second: p1 | (p2 | p3). A finger on the split button, twice.
            await tap(page, ".gt-split");
            await settle(page, 1200);
            await tap(page, ".gt-split");
            await settle(page, 1400);

            expect(await panes(page)).toBe(3);

            // A shell ends in the third pane, as a person's does with Control+D.
            await page.evaluate(() => {
                const focused = document.querySelector(".gt-pane.is-focused .gt-input") as HTMLTextAreaElement;

                focused.focus();
                focused.value = "\u0004";
                focused.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            // The pane goes when its shell's end reaches the page: wait for that, not for a guess at how long it takes.
            await page.waitForFunction(() => document.querySelectorAll(".gt-pane").length === 2, { timeout: 15_000 });

            expect(await panes(page)).toBe(2);
            expect(await focusedPane(page)).toBe(1);

            // And the panes that are left still answer: two shells, two prompts.
            const prompts = await page.$$eval(".gt-pane", (all) =>
                all.filter((pane) => (pane.querySelector(".gt-screen")?.textContent ?? "").includes("❯")).length,
            );

            expect(prompts).toBe(2);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("closing a pane gives the keys back to the pane it was split from", async () => {
        const page = await openPhone();

        try {
            await tap(page, ".gt-split"); // a pane to the right: two panes, the second has the keys
            expect(await focusedPane(page)).toBe(1);

            await tap(page, ".gt-close"); // the close of a pane, which is there once there is more than one
            await settle(page, 900);

            expect(await panes(page)).toBe(1);
            expect(await focusedPane(page)).toBe(0);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("where the cursor sits", () => {
    /**
     * The cursor is drawn at the terminal's column, and the text is drawn by a font. If a glyph takes more room than the
     * cell that the terminal counted for it, the text runs past the cursor and a person sees a cursor that is not where
     * the next letter goes. The cursor may be a little ahead of the ink -- a line's last blanks are trimmed -- but the
     * ink must never pass it.
     */
    const where = (page: Page) =>
        page.evaluate(() => {
            const screenEl = document.querySelector(".gt-screen") as HTMLElement;
            const screen = screenEl.getBoundingClientRect();
            const cursor = (document.querySelector(".gt-cursor") as HTMLElement).getBoundingClientRect();
            const cellW = Number.parseFloat(getComputedStyle(screenEl).getPropertyValue("--gt-cell-w"));
            const rows = [...document.querySelectorAll(".gt-row")] as HTMLElement[];
            const top = cursor.top - screen.top;
            const row = rows.find((each) => Math.abs(each.getBoundingClientRect().top - screen.top - top) < 2);

            if (row === undefined) return null;

            const spans = [...row.children] as HTMLElement[];
            const ink = spans.length === 0 ? row.getBoundingClientRect().left : spans[spans.length - 1]!.getBoundingClientRect().right;

            return { cells: (cursor.left - ink) / cellW, text: row.textContent ?? "" };
        });

    /** How far the ink may be behind the cursor: the trailing blanks of a line, and no more. */
    const holdsTheLine = (found: { cells: number } | null) => {
        expect(found).not.toBeNull();
        expect(found!.cells).toBeGreaterThan(-0.2);
        expect(found!.cells).toBeLessThan(6);
    };

    test("after a prompt of the shape a shell draws", async () => {
        const page = await openPhone();

        try {
            // The shell's own prompt, drawn where there is nothing else on the line: a name, a branch in italics, an
            // editor's glyph and the prompt's arrow, which is what a person's line looks like.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value =
                    "clear; printf 'tom on \\033[3mcall-graphs:master\\033[0m \\uea71 \\u276f '; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    test("after a typed line", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "abcdefghijklmnopqrst";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 700);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    test("after a line of an editor's glyphs", async () => {
        const page = await openPhone();

        try {
            // A tree as a shell draws one with an icon font: the glyphs that a cell grid has to count like any other.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf '\\ue0b0\\uf121\\uf07b\\ue0b0\\uf121\\uf07b'; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    test("after a line of wide glyphs", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf '你好世界你好世界'; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });

    /**
     * The case that a person sees as "the letters go in the right place and the cursor is somewhere else": a font whose
     * glyphs are not one cell wide, which is what a proportional build of a Nerd font is. The page draws each run in the
     * cells that the terminal gave it, so the text cannot walk away from the cursor.
     */
    test("after a line drawn in a font that is not a grid", async () => {
        const page = await openPhone();

        try {
            await page.$eval(".gt-screen", (screen) => {
                (screen as HTMLElement).style.fontFamily = "Georgia, serif";
            });
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                // The widest letter there is, in a font that gives each glyph its own width.
                input.value = "printf 'WWWWWWWWWW'; sleep 2\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            holdsTheLine(await where(page));
        } finally {
            await page.close();
        }
    });
});

describe("the font the screen draws with", () => {
    /**
     * Pi Pocket serves JetBrains Mono as "Pocket Mono" and the Nerd patch's icons as "Pocket Nerd Symbols", and both
     * are in every tab: a terminal that draws with them looks the same on a laptop, a phone and a machine with nothing
     * installed. The text font comes first in the stack, and the icons font beside it for the private use areas.
     */
    test("is Pocket Mono, with the icons of the symbols font beside it", async () => {
        const page = await openPhone();

        try {
            const declared = await page.$eval(".gt-screen", (screen) => getComputedStyle(screen).fontFamily);

            expect(declared.replaceAll("'", '"')).toStartWith('"Pocket Mono"');
            expect(declared).toContain("Pocket Nerd Symbols");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("draws an editor's icon, which is not in the text font at all", async () => {
        const page = await openPhone();

        try {
            const ink = await page.evaluate(async () => {
                const screen = document.querySelector(".gt-screen") as HTMLElement;
                const canvas = document.createElement("canvas");

                canvas.width = 32;
                canvas.height = 32;

                const context = canvas.getContext("2d") as CanvasRenderingContext2D;

                await document.fonts.ready;
                context.font = `24px ${getComputedStyle(screen).fontFamily}`;
                context.fillStyle = "#fff";
                context.fillText("\uf121", 2, 24);

                return [...context.getImageData(0, 0, 32, 32).data].reduce((sum, value, at) => (at % 4 === 3 ? sum + value : sum), 0);
            });

            expect(ink).toBeGreaterThan(0);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the width of a cell", () => {
    /**
     * The cell is measured from the font, and a font is not there when the page first draws: a browser paints with the
     * fallback and swaps the real font in when it has it. A cell measured against the fallback is a cell that is not the
     * font's, so every run is a little too wide or too narrow and the line overlaps itself -- which is what a person
     * sees as a garbled prompt.
     */
    test("is measured again when the font arrives after the first paint", async () => {
        const page = await browser.newPage();

        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.setRequestInterception(true);

        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));

        page.on("request", async (request) => {
            const url = request.url();

            // The app's font is held back, and the page is given another font to measure while it waits -- which is what
            // a browser does with its fallback, only with a font that is not a monospace at all.
            if (url.includes("JetBrainsMono.woff2")) {
                await held;
                await request.continue().catch(() => {});

                return;
            }

            if (request.resourceType() === "document") {
                const answer = await fetch(url);
                const body = (await answer.text()).replace("</head>", "<style>.gt-screen { font-family: Georgia, serif !important }</style></head>");

                await request.respond({ status: 200, contentType: "text/html", body }).catch(() => {});

                return;
            }

            await request.continue().catch(() => {});
        });

        try {
            await page.goto(`${URL_BASE}/`, { waitUntil: "domcontentloaded" });
            await page.waitForSelector(".gt-pane .gt-row");
            await settle(page, 600);

            const before = await cellWidth(page);

            // The stand-in goes, and the font arrives: from here the page draws with another font than the one it
            // measured its cells with.
            await page.evaluate(() => {
                for (const style of document.querySelectorAll("style")) {
                    if ((style.textContent ?? "").includes("Georgia")) style.remove();
                }
            });
            release();
            await page.evaluate(() => document.fonts.ready);
            await settle(page, 800);

            const after = await cellWidth(page);
            const truth = await measuredCell(page);

            // The first measurement was the stand-in font's, and the one that counts is the font's the page ends with.
            expect(Math.abs(after - truth)).toBeLessThan(0.05);
        } finally {
            await page.close();
        }
    }, 30_000);

    /** The cell that the screen draws with. */
    const cellWidth = (page: Page) =>
        page.$eval(".gt-screen", (screen) =>
            Number.parseFloat(getComputedStyle(screen).getPropertyValue("--gt-cell-w")),
        );

    /** The width of the font's own cell, measured in the screen's font as it is now. */
    const measuredCell = (page: Page) =>
        page.$eval(".gt-screen", (screen) => {
            const probe = document.createElement("span");

            probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
            probe.textContent = "0123456789";
            screen.append(probe);

            const width = probe.getBoundingClientRect().width / 10;

            probe.remove();

            return width;
        });
});

describe("rendering in a scaled container", () => {
    test("keeps adjacent prompt segments from overlapping", async () => {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on("request", async (request) => {
            if (request.isNavigationRequest()) {
                const response = await fetch(request.url());
                const html = (await response.text()).replace(
                    "</head>",
                    "<style id=opening-animation>body { transform: scale(0.9); transform-origin: top left }</style></head>",
                );
                await request.respond({ status: 200, contentType: "text/html", body: html });
            } else {
                await request.continue();
            }
        });

        try {
            await page.goto(`${URL_BASE}/`, { waitUntil: "networkidle2" });
            await page.waitForSelector(".gt-input");
            // End the opening animation after the terminal has measured itself.
            await page.evaluate(() => document.querySelector("#opening-animation")!.remove());
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;
                input.value = "printf '\\033[1mpi-pocket-ghostty\\033[0m on \\033[3mpi-pocket-ghostty\\033[0m END\\n'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await page.waitForFunction(() => [...document.querySelectorAll(".gt-row")].some(
                (row) => row.textContent?.includes("pi-pocket-ghostty on pi-pocket-ghostty END"),
            ));
            const overlap = await page.evaluate(() => {
                const row = [...document.querySelectorAll(".gt-row")].find(
                    (element) => element.textContent?.includes("pi-pocket-ghostty on pi-pocket-ghostty END"),
                )!;
                const spans = [...row.children];
                const first = spans.find((element) => element.textContent === "pi-pocket-ghostty")!;
                const next = first.nextElementSibling!;
                const range = document.createRange();
                range.selectNodeContents(first);
                return range.getBoundingClientRect().right - next.getBoundingClientRect().left;
            });
            expect(overlap).toBeLessThan(0.5);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the width of a run", () => {
    /**
     * Each run of a row is drawn in exactly the cells that the terminal gave it, so its glyphs have to fit inside that
     * box: text that spills out of it is text that overlaps the run after it, which a person sees as a line whose words
     * are on top of each other. A bold or an italic that a font does not have is the usual reason -- a browser makes one
     * up by thickening the letters, and a made-up bold is wider than the cell.
     */
    const overflow = (page: Page) =>
        page.evaluate(() => {
            const rows = [...document.querySelectorAll(".gt-row")] as HTMLElement[];
            const worst: Array<{ text: string; over: number }> = [];

            for (const row of rows) {
                for (const span of [...row.children] as HTMLElement[]) {
                    const box = span.getBoundingClientRect().width;
                    const range = document.createRange();

                    range.selectNodeContents(span);

                    const ink = range.getBoundingClientRect().width;
                    const over = ink - box;

                    if (over > 1) worst.push({ text: (span.textContent ?? "").slice(0, 16), over: Math.round(over) });
                }
            }

            return worst;
        });

    const drawWith = async (page: Page, body: string) => {
        await page.evaluate((text: string) => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.focus();
            input.value = `clear; printf '${text}'; sleep 2\n`;
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, body);
        await settle(page, 900);
    };

    test("holds a bold line and an italic line inside their cells", async () => {
        const page = await openPhone();

        try {
            await drawWith(page, "\\033[1mtom on call-graphs:master\\033[0m");
            expect(await overflow(page)).toEqual([]);

            await drawWith(page, "\\033[1;3mtom on call-graphs:master\\033[0m");
            expect(await overflow(page)).toEqual([]);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("never makes up a weight, which is a bold that is wider than a cell", async () => {
        const page = await openPhone();

        try {
            const synthesis = await page.$eval(".gt-screen", (screen) => {
                const style = getComputedStyle(screen);

                return { weight: style.fontSynthesisWeight, style: style.fontSynthesisStyle };
            });

            expect(synthesis.weight).toBe("none");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the bar above the screen", () => {
    /** The bar's buttons, by the class that says what they do. */
    const bar = (page: Page) =>
        page.$eval(".gt-bar", (element) => {
            const buttons = [...element.querySelectorAll(".button")] as HTMLElement[];
            return {
                words: (element.textContent ?? "").replaceAll("\n", "").trim(),
                icons: buttons.map((each) => ({
                    label: each.getAttribute("title") ?? "",
                    svg: each.querySelector("svg") !== null,
                })),
            };
        });

    test("says nothing about the session, which the page around it already says", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "printf $'\\033]0;pi-pocket-ghostty\\007'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 700);

            const shown = await page.evaluate(() => ({
                name: document.querySelector(".gt-bar .gt-name") !== null,
                folder: document.querySelector(".gt-bar .gt-cwd") !== null,
                title: document.querySelector(".gt-bar .gt-title") !== null,
                words: (document.querySelector(".gt-bar")?.textContent ?? "").trim(),
            }));

            // The title that a shell sets and the folder are the session's, and the page around the panel says them.
            expect(shown.name).toBe(false);
            expect(shown.title).toBe(false);
            expect(shown.folder).toBe(false);
            expect(shown.words).not.toContain("pi-pocket-ghostty");
            expect(shown.words).not.toContain("/");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("draws every button in the bar at one size", async () => {
        // A panel wide enough for the whole bar, which is where every button is on the page at once.
        const page = await openWide();

        try {
            // A drawing of a box and a letter are the same button: one height, one size of its letters or its icon.
            const sizes = await page.$eval(".gt-bar", (actions) => {
                // The text size's buttons fold away in a narrow panel, and a button that is not there has no size.
                const buttons = ([...actions.querySelectorAll(".button")] as HTMLElement[]).filter(
                    (each) => each.getClientRects().length > 0,
                );

                return buttons.map((each) => {
                    const icon = each.querySelector("svg");

                    const rect = each.getBoundingClientRect();

                    return {
                        label: each.getAttribute("title") ?? "",
                        box: Math.round(rect.height * 10) / 10,
                        width: Math.round(rect.width * 10) / 10,
                        letters: Number.parseFloat(getComputedStyle(each).fontSize),
                        icon: icon === null ? null : Math.round(icon.getBoundingClientRect().height * 10) / 10,
                    };
                });
            });

            const boxes = new Set(sizes.map((each) => each.box));
            const widths = new Set(sizes.map((each) => each.width));
            const letters = new Set(sizes.map((each) => each.letters));

            // The splits, the two that say what they do with a drawing, and the pane's own close when there is one.
            expect(sizes.length).toBeGreaterThanOrEqual(4);
            expect([...boxes]).toHaveLength(1);
            expect([...widths]).toHaveLength(1);
            expect([...letters]).toHaveLength(1);

            // An icon is drawn at the size of the letters beside it, which is what makes its button that size too.
            for (const each of sizes) {
                if (each.icon !== null) expect(Math.abs(each.icon - each.letters)).toBeLessThan(0.6);
            }
        } finally {
            await page.close();
        }
    }, 30_000);

    /**
     * The splits' pictures are drawn, not typed: a glyph brings whatever weight and size its font has, and the two that
     * the page had were a fill against the octicons' outlines. Each is the frame of a box, a square corner rounded a
     * little, with the line that the split makes through it.
     */
    test("draws both splits as the frame of a box, the size of the other icons", async () => {
        const page = await openPhone();

        try {
            const shapes = await page.evaluate(() => {
                const box = (element: Element) => {
                    const rect = element.getBoundingClientRect();

                    return { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
                };
                const splits = [...document.querySelectorAll(".gt-split")].map((button) => ({
                    glyph: button.querySelector(".gt-glyph") !== null,
                    icon: button.querySelector("svg") === null ? null : box(button.querySelector("svg")!),
                    box: box(button),
                    // Every path of an icon is filled, and the frame is the first: a shape is its outline, not a fill.
                    paths: [...button.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? ""),
                }));
                const icons = [...document.querySelectorAll(".gt-actions .button:not(.gt-split) svg")]
                    .filter((svg) => svg.getClientRects().length > 0)
                    .map((svg) => box(svg));

                return { splits, icons };
            });

            expect(shapes.splits).toHaveLength(2);

            for (const split of shapes.splits) {
                expect(split.glyph).toBe(false);
                expect(split.icon).not.toBeNull();
                // An icon of the same box is an icon of the same size: the ink of both is a pixel inside it.
                expect(split.icon).toEqual(shapes.icons[0]!);
                expect(split.paths.length).toBe(2);
            }

            // One frame with a line across it, and another with a line down it: both the same frame.
            expect(shapes.splits[0]!.paths[0]).toBe(shapes.splits[1]!.paths[0]);
            expect(shapes.splits[0]!.paths[1]).not.toBe(shapes.splits[1]!.paths[1]);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("keeps the shell's own buttons on the left and the text size on the right", async () => {
        const page = await openWide();

        try {
            const row = await page.$eval(".gt-bar", (bar) => {
                const buttons = [...bar.querySelectorAll(".button")].filter((each) => each.getClientRects().length > 0);
                const at = (label: string) => {
                    const button = buttons.find((each) => each.getAttribute("title") === label);

                    return button === undefined ? null : button.getBoundingClientRect();
                };
                const gap = (left: string, right: string) => {
                    const one = at(left);
                    const other = at(right);

                    return one === null || other === null ? null : Math.round((other.left - one.right) * 10) / 10;
                };

                return {
                    order: buttons.map((each) => each.getAttribute("title")),
                    button: Math.round(buttons[0]!.getBoundingClientRect().width),
                    afterNewShell: gap("New shell", "A pane to the right (Control+Shift+D)"),
                    beforeEnd: gap("Larger text", "End"),
                    endsRight: Math.round(window.innerWidth - at("End")!.right),
                };
            });

            // A new shell, a button's width of air, the splits: and on the other side, the text size and the end.
            expect(row.order[0]).toBe("New shell");
            expect(row.order.at(-1)).toBe("End");
            expect(row.afterNewShell).toBeCloseTo(row.button, 0);
            expect(row.beforeEnd).toBeCloseTo(row.button, 0);
            // The two groups sit at the two ends of the bar, not gathered at one.
            expect(row.endsRight).toBeLessThan(20);
            expect(row.order.indexOf("Smaller text")).toBeGreaterThan(row.order.indexOf("A pane below (Control+Shift+E)"));
        } finally {
            await page.close();
        }
    }, 30_000);

    test("says what every button does with an icon", async () => {
        // A panel wide enough for the whole bar: a narrow one folds the text size's buttons away.
        const page = await openWide();

        try {
            const marked = await page.$$eval(".gt-actions .button", (buttons) =>
                buttons
                    .filter((each) => each.getClientRects().length > 0)
                    .map((each) => ({ label: each.getAttribute("title") ?? "", svg: each.querySelector("svg") !== null })),
            );

            // A drawing says it in one language, where a word has to be translated or shortened to fit.
            for (const button of marked) expect(button).toEqual({ label: button.label, svg: true });
            expect(marked.map((each) => each.label)).toContain("Smaller text");
            expect(marked.map((each) => each.label)).toContain("Larger text");
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the room inside the frame", () => {
    /**
     * A frame with a rounded corner and text that begins at the corner's own edge looks like a page that was cut to fit.
     * The screen keeps a margin of its own inside its border, and the columns and rows that it asks the pty for are the
     * ones that fit in that margin: a count that took the padding for room for a column would run under the frame.
     */
    test("keeps the screen's text off its frame, and counts only the room that is left", async () => {
        const page = await openWide();

        try {
            // A line longer than the terminal is wide: it wraps at the last column, so the row's own end is the edge.
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.focus();
                input.value = "clear; printf 'x%.0s' $(seq 1 300)\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            const room = await page.evaluate(() => {
                const screen = document.querySelector(".gt-screen") as HTMLElement;
                const style = getComputedStyle(screen);
                const frame = screen.getBoundingClientRect();
                const content = frame.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
                const width =
                    screen.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
                const right = Math.max(
                    ...[...document.querySelectorAll(".gt-row > span")].map((span) => span.getBoundingClientRect().right),
                );
                const row = document.querySelector(".gt-row") as HTMLElement;
                const cursor = document.querySelector(".gt-cursor") as HTMLElement;

                return {
                    padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
                        (each) => Math.round(Number.parseFloat(each) * 10) / 10,
                    ),
                    radius: Math.round(Number.parseFloat(style.borderTopLeftRadius)),
                    width: Math.round(width),
                    cell: Number.parseFloat(style.getPropertyValue("--gt-cell-w")),
                    // Where the text begins, and how far the row of it reaches, both from the frame's inner edge.
                    startsAt: Math.round(row.getBoundingClientRect().left - content),
                    reaches: Math.round(right - content),
                    cursorAt: Math.round(cursor.getBoundingClientRect().top - frame.top),
                    top: Math.round(row.getBoundingClientRect().top - frame.top),
                };
            });

            // A margin inside the frame, a pixel less than the corner that it runs beside, and the same on every side.
            expect(new Set(room.padding).size).toBe(1);
            expect(room.padding[0]!).toBeGreaterThan(4);
            expect(room.padding[0]!).toBeLessThanOrEqual(room.radius);

            // The text begins at that margin, and the row of it ends inside the margin on its own side.
            expect(Math.abs(room.startsAt)).toBeLessThanOrEqual(1);
            expect(room.reaches).toBeLessThanOrEqual(room.width + 1);
            expect(room.reaches).toBeGreaterThan(room.width - room.cell * 2);
            expect(room.top).toBeGreaterThanOrEqual(room.padding[0]! - 1);
            expect(room.cursorAt).toBeGreaterThanOrEqual(room.padding[0]! - 1);
        } finally {
            await page.close();
        }
    }, 30_000);
});

describe("the screen", () => {
    test("draws what the shell prints", async () => {
        const page = await openPhone();

        try {
            await page.evaluate(() => {
                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.value = "echo the-screen-works\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await settle(page, 900);

            const text = await page.$eval(".gt-screen", (screen) => screen.textContent ?? "");

            expect(text).toContain("the-screen-works");
        } finally {
            await page.close();
        }
    }, 30_000);

    test("copies what a program copies with OSC 52", async () => {
        const page = await openPhone();

        try {
            const copied = await page.evaluate(async () => {
                const written: string[] = [];
                const clipboard = navigator.clipboard;

                Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
                });

                const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

                input.value = "printf '\\033]52;c;aGVsbG8=\\a'\n";
                input.dispatchEvent(new InputEvent("input", { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 900));
                Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

                return written;
            });

            expect(copied).toEqual(["hello"]);
        } finally {
            await page.close();
        }
    }, 30_000);

    test("draws the cursor that a program asks for", async () => {
        const page = await openPhone();

        try {
            // A program asks for a bar and then waits, so that the shell's own prompt does not paint over the answer.
            const bar = await shapeOf(page, "\\033[6 q");

            expect(bar.look).toBe("bar");
            expect(bar.width).toBeLessThan(4);

            const block = await shapeOf(page, "\\033[2 q");

            expect(block.look).toBe("block");
            expect(block.width).toBeGreaterThan(4);
        } finally {
            await page.close();
        }
    }, 30_000);

    /** Runs a program that asks for a cursor shape, and gives back what the screen drew while it ran. */
    async function shapeOf(page: Page, escape: string): Promise<{ look: string; width: number }> {
        await page.evaluate((codes: string) => {
            const input = document.querySelector(".gt-input") as HTMLTextAreaElement;

            input.focus();
            input.value = `printf '${codes}'; sleep 2\n`;
            input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }, escape);
        await settle(page, 900);

        const shape = (await page.$eval(".gt-cursor", (cursor) => ({
            look: (cursor as HTMLElement).dataset.look ?? "",
            width: Number.parseFloat(getComputedStyle(cursor).width),
        }))) as { look: string; width: number };

        // The shell takes the screen back when the program ends, and with it its own cursor shape.
        await settle(page, 2200);

        return shape;
    }
});

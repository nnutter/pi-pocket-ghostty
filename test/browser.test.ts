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
            await tap(page, ".gt-actions button");

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

    test("closing a pane gives the keys back to the pane it was split from", async () => {
        const page = await openPhone();

        try {
            await tap(page, ".gt-actions button"); // a pane to the right: two panes, the second has the keys
            expect(await focusedPane(page)).toBe(1);

            await tap(page, ".gt-actions button:nth-of-type(3)"); // the third button is the close of a pane
            await settle(page, 900);

            expect(await panes(page)).toBe(1);
            expect(await focusedPane(page)).toBe(0);
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

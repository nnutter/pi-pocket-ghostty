# pi-pocket-ghostty

A real terminal in Pi Pocket: a pty in one of your session's folders, parsed by Ghostty's own VT engine
([`libghostty-vt`](https://github.com/prime-radiant-inc/ts-libghostty)), drawn in the app's page.

Pi Pocket has no terminal. Its shell commands (`!git status`) and background tasks run without a pty, so a program that
asks the terminal what it is, moves a cursor, or waits for a keystroke cannot run there. This extension gives those
programs a real one: `vim`, `less`, `ssh`, a REPL, `watch`.

## What it needs

- **Bun** (1.3.13 or newer), because `libghostty-vt` is a Bun FFI binding. Pi Pocket's server runs on Node, so the
  extension starts a Bun process for each terminal and talks to it in JSON lines. The module finds Bun in `PATH`, in
  mise's installs, or where its own setting says.
- **Linux x64 or arm64, or macOS arm64**: the platforms that `libghostty-vt` ships a prebuilt library for.

## Install

```bash
bun run scripts/install.ts      # or: mise run ext:install
```

It writes:

| Where                                      | What                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `~/.pi-pocket/extensions/ghostty-terminal.ts`  | the module: routes, events, the terminals                         |
| `~/.pi-pocket/extensions/ghostty-terminal/`    | the browser module: the page, its screen, its stylesheet          |
| `~/.pi-pocket/ghostty-terminal/`               | the runtime: `pty-host.ts` and `libghostty-vt`                    |

Then turn it on in **Menu → Extensions → Ghostty terminal**, and open **Terminal** on the rail. Set `PI_POCKET_DATA`
to install into another data folder.

Settings, in Menu → Extensions: the shell to run (empty: your own, with `-l`), the Bun binary, and the runtime folder.

## How it is put together

- `src/ghostty-terminal.ts` — the drop-in module. One Bun process for each terminal, a `Terminal` record with the
  screen that it last sent, and the routes that the page calls: create, attach, input, resize, scroll, end.
- `src/pty-host.ts` — the Bun side: `Bun.spawn` with a pty, `Terminal` + `RenderState` from `libghostty-vt`, and a
  frame of the rows that changed, at most one each 16 ms.
- `src/web/index.js` — the page on the rail, and a launcher action.
- `src/web/terminal.js` — the screen: runs of cells painted into rows of spans, the cursor, the wheel for scrollback,
  and a hidden textarea whose keystrokes go to `libghostty-vt`'s key encoder on the server.
- `src/web/terminal.css` — the look, from the app's theme tokens.

Why the extra process: `libghostty-vt` imports `bun:ffi`, which Node does not have. Nothing else needs Bun.

## Keys

| Key                    | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `Control+Backquote`    | opens the terminal, or puts it away            |
| `Control+Shift+D`      | a pane to the right                            |
| `Control+Shift+E`      | a pane below                                   |
| `Control+Shift+X`      | closes the pane that has the keys              |
| `Alt+arrow`            | moves the keys to the pane in that direction   |

Ghostty's own bindings use Super: `super+d` for a split right, `super+shift+d` for one below, `super+alt+arrow` to move
between them. A browser keeps Super and `Ctrl+W` for itself, so this page uses Control with Shift, and its own key for
closing a pane.

Each pane is a terminal of its own, with a pty of its own at its own size. Closing the page ends the panes that would
show nowhere and keeps the shell of the first: the one a person comes back to is the one that was there.

## What the page says, and where

A shell that ends well takes its page with it, as a terminal's own window does, and says nothing. A shell that ends any
other way keeps its page open with what happened — `The shell was interrupted.` after a `^C` and a `^D`, the code
otherwise — a **New shell** button, and a way to put the note away. The note lies over the screen instead of above it,
because a line taken from a terminal changes the columns and rows of everything in it.

## A phone's keyboard

A soft keyboard has no Escape and no Control, so the page puts a row above it: a round Control, a band of keys that
scrolls sideways, and a round button that puts the keyboard away. It starts with what a shell and an editor reach for
first — Escape, Tab, the modifiers, the arrows, Home and End, the page keys — then the characters that a keyboard keeps
on its second page.

The row waits for a soft keyboard. A keyboard either takes a keyboard's worth of height, as this app's viewport setting
makes it do, or covers the window without resizing it; a Bluetooth keyboard does neither, so with one there is no row.
Tapping a modifier arms it for the next key, typed or tapped: `Control`, then `←`, is a word back.

## Neovim

Neovim runs in this terminal with its own modes, registers, and motions, because the terminal answers what Neovim asks
of a terminal:

- **`+` copies to the system clipboard**, and `+` pastes from it, through OSC 52. Neovim needs a clipboard provider that
  speaks it; nothing else on the machine is involved, so this works over SSH and from a phone too.

  ```lua
  local osc52 = require("vim.ui.clipboard.osc52")

  vim.g.clipboard = {
      name = "OSC 52",
      copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
      paste = { ["+"] = osc52.paste("+"), ["*"] = osc52.paste("*") },
  }
  vim.opt.clipboard = "unnamedplus"
  ```

  A copy comes from Neovim, not from the person's own keystroke, and a browser may refuse it or ask first. The page
  falls back when it can, and says in the bar when a copy did not land.
- **The cursor is a block in normal mode and a bar in insert mode**, as `guicursor` says (DECSCUSR). Underline and blink
  come through too.
- **A paste is a bracketed paste** when Neovim asked for one, so `:set paste` is not needed and autoindent stays honest.
- **Focus changes go in** (DECSET 1004), for a `FocusGained` autocmd.

Keys are encoded by Ghostty's key encoder on the server, with the modes that Neovim set, so `<C-a>`, `<C-6>`, Alt keys,
and the arrow keys are what Neovim asked for. One key is not: a browser keeps **`<C-w>`** for closing a tab, and a page
cannot take it back. Use `<C-w>` alternatives, or install Pi Pocket as an app, where the window may let it through.

## What it does not do

- **A terminal ends with the server, or with the extension's next version.** A save of
  `~/.pi-pocket/extensions/ghostty-terminal.ts` starts new shells.
- **One terminal for each folder.** Opening the page again finds the one you left, with its screen.
- **No mouse, no images.** Keys and text go in; the screen comes out. Kitty graphics and mouse tracking are not wired,
  so clicking a file name in a full-screen program does nothing.
- **The shell is the person's own.** A drop-in runs with its owner's rights, and so does anything typed in this page.
  The page and its routes are for the owner alone; guests and viewers get no route at all.

## Development

```bash
mise run preview     # a page with a real shell at http://127.0.0.1:4711, without Pi Pocket
mise run test        # the module against a real pty: keys, resize, scroll, ending
mise run check       # tsc --noEmit
```

`scripts/preview.ts` serves the module's own routes behind a small HTTP server and gives the page a fake `pocket`, so
the screen can be tried in a browser before Pi Pocket loads the extension. `test/fake-web.ts` is the same idea for
tests: it records what the module sends and lets a test call its routes.

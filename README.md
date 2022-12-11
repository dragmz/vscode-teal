# TEAL

Algorand TEAL language support for Visual Studio Code

## Installation

Just install the extension in your VS Code.

## Features

- **Code completion** - suggests opcodes while typing or activated manually with **Ctrl+Space**; includes documentation and snippets
- **Signature help** - opcodes signature information popup activated with **Ctrl+Shift+Space**
- **Hover info** - documentation appears when hovering over an opcode
- **Code formatting** (thanks to [joe-p/tealfmt](https://github.com/joe-p/tealfmt/)) - use unified TEAL formatting for your code with **Shift+Alt+F**
- **Go to definition** - jump to a referenced label with F12 or **Ctrl+LMB**
- **Go to symbol** - search and go to labels with **Ctrl+Shift+O**
- **Document outline** - see all the labels in the Outline view
- **Syntax highlighting** - semantic-aware code highlighting
- **Rename symbol** - rename labels directly or via references with **F2**
- **Syntax validation** - list syntax errors in the Problems tab
- **Linting** - detect and list common TEAL issues in the Problems tab
- **Create missing label** - add a missing label, referenced by opcodes with **Ctrl+.**
- **Check for updates** - automatically check for TEAL LSP server updates at startup and update optionally with a single button click

## Dependencies

This extension depends on tealsp (TEAL LSP server). The LSP server should get automatically installed when then extension is activated.

Follow one of the instructions below if the automatic tealsp installation fails.

### Install tealsp using Visual Studio Code command

- Install this Visual Studio Code extension
- Execute 'TEAL: Install/Update Tools' command

### Install tealsp from a command line

- Linux
```commandline
GOPROXY=direct go install github.com/dragmz/teal/cmd/tealsp@latest
```

- Windows
```commandline
set GOPROXY=direct && go install github.com/dragmz/teal/cmd/tealsp@latest
```

Then install this Visual Studio Code extension
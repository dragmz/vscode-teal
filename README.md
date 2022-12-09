# TEAL

Algorand TEAL language support for Visual Studio Code

## Dependencies

This extension depends on tealsp (TEAL LSP Server). The LSP server should get automatically installed when then extension is activated.

## Manual tealsp installation

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
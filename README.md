# TEAL

Algorand TEAL language support for Visual Studio Code

## Dependencies

This extension depends on tealsp (TEAL LSP Server). The LSP server can be installed using a command or manually:

## Using a command to install tealsp

- Install this Visual Studio Code extension
- Execute 'TEAL: Install/Update Tools' command

### Installing tealsp manually

- Linux
```commandline
GOPROXY=direct go install github.com/dragmz/teal/cmd/tealsp@latest
```

- Windows
```commandline
set GOPROXY=direct && go install github.com/dragmz/teal/cmd/tealsp@latest
```

- Then install this Visual Studio Code extension
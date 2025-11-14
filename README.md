# Google C++ Style Fixer

VS Code extension that runs `clang-tidy` + `clang-format` over your C/C++ project and brings it close to [Google C++ Style Guide](https://google.github.io/styleguide/cppguide.html) — with a few opinionated tweaks:

- tabs are allowed (and visually 4 spaces wide);
- all one-line `if` / `for` / `while` get proper braces and line breaks;
- naming is normalized via `clang-tidy`’s `readability-identifier-naming`;
- no forced C++-style casts everywhere;
- no `auto main() -> int` nonsense.

Everything happens **only when you explicitly run the command**. No background “helpfulness”, no surprise edits while you type.

---

## Features

- Run a single command:  
  **“Fix C++ Google Style in Workspace”**  
  and the extension will:
  - find all C/C++ files in the workspace matching configured glob patterns;
  - run `clang-tidy -fix` on each file;
  - then run `clang-format -i` on each file.

- Uses your existing style configuration:
  - global `~/.clang-format` or project `.clang-format`;
  - global `~/.clang-tidy` or project `.clang-tidy`.

- Honors your indentation preferences:
  - tabs enabled;
  - tab width = 4;
  - VS Code C/C++ settings can stay with tabs, not spaces.

- One-shot changes:
  - the extension does nothing on save, nothing on type;
  - it only modifies files when you explicitly call the command.

---

## Requirements

You need these tools installed and available in `PATH`:

- `clang-format`
- `clang-tidy`

Check with:

```bash
clang-format --version
clang-tidy --version

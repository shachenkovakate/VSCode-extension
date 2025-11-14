bash -lc 'cat > README.md << "MD"
# Google C++ Style Guard

Enforce **Google C++ Style** in VS Code using `clang-format` (tabs width 4) and `clang-tidy` style-only checks (braces + identifier naming).

## Features
- Writes `.clang-format` with `BasedOnStyle: Google`, `IndentWidth: 4`, `TabWidth: 4`, `UseTab: Always`.
- Writes `.clang-tidy` limited to:
  - `readability-braces-around-statements`
  - `readability-identifier-naming` (Google-like schema)
- Formats current file with `clang-format`.
- Optionally applies tidy *style* fixes (no modernize/perf/bugprone).

## Commands
- **GCS: Write .clang-format (Google)** — `gcs.writeClangFormat`
- **GCS: Write .clang-tidy (Google naming + braces)** — `gcs.writeClangTidy`
- **GCS: Format Current File** — `gcs.formatCurrent`
- **GCS: Enforce Google Style (…current file)** — `gcs.enforceStyleCurrent`

## Settings
- `gcs.format.path` — path to `clang-format` (default: `clang-format`)
- `gcs.tidy.path` — path to `clang-tidy` (default: `clang-tidy`)
- `gcs.compileCommandsPath` — compile DB (default: `build/compile_commands.json`)

## Requirements
Install LLVM tools:
```bash
sudo apt-get install clang-format clang-tidy

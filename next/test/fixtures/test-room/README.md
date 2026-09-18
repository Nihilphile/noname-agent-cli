# Native selection fixture

`native-selection.json` captures the complete `chooseCharacterOL` (doudizhu)
and `chooseCharacterOL2` (versus) functions from the local 子琪 v1.11.3 source
on 2026-09-18. Each entry records the original source path and complete-file
SHA-256. These GPL-3.0-only excerpts use the same license as this project.

The test executes the patched native candidate allocation and faction assignment
with shuffled player order, including the 2v2 side broadcast callback. It does
not simulate the full engine, UI, or network; live evidence covers those paths.

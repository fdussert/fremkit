import { defineConfig } from 'vite-plus'

// The repository has no Vite project of its own — the UI and the server each have one. This file
// is where `vp lint`, run from the root, is configured for the whole tree.
//
// The widgets and themes are left out: they ship to a user's Edge byte for byte, and a lint
// finding there is a change to a published file, not to this repository's source.
export default defineConfig({
  lint: {
    ignorePatterns: ['widgets/**', 'themes/**', 'data/**'],
  },
})

# Fast Todos

> **Note**: This plugin is originally branched from the [obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) repository. The primary goal of this fork is to drastically simplify the user experience, remove heavy dependencies, and pivot the design toward a minimalistic aesthetics-first approach.

**Fast Todos** is a lightweight, high-performance task management plugin for Obsidian. It is designed for users who want a beautiful, unified view of their vault's tasks without the performance "weight" often associated with complex task managers.

## 🔋 Engineered for Battery Life
The core philosophy of Fast Todos is **Zero-Impact Productivity**. While other managers might constantly poll your files or index your vault in the background, Fast Todos uses several aggressive optimizations to ensure your Mac stays cool and your battery stays full:

- **The "Broadcast" Sync System**: Unlike traditional plugins that re-scan your hard drive when you type, Fast Todos uses an in-memory broadcast system. The editor sends tiny, zero-cost signals to visible task blocks only when a status change is detected.
- **Micro-Debouncing**: Task detection logic is debounced to 500ms. If you're typing quickly, the plugin stays dormant until you pause, ensuring zero idle CPU impact.
- **Surgical Vault Scanning**: The plugin utilizes Obsidian's internal `cachedRead` system, reading from RAM rather than the SSD whenever possible.
- **Dual-Speed Caching**: Your active file is synced with near-zero lag, while the rest of your vault is managed with a "Lazy Cache" that only refreshes every 10 seconds.

## ✨ Features
- **Minimalistic UI**: A clean, distraction-free task list with hover-based actions.
- **Magic Sync**: Marking a task as done in your Markdown notes (typing `[x]`) instantly updates the task list with no lag.
- **5-Second Grace Period**: Checking a task in the plugin starts a satisfying 5-second countdown. This gives you a clear window to undo accidental clicks before the task is archived.
- **Universal Tag Sync**: Automates the addition and removal of `[completed: YYYY-MM-DD]` tags without stripping your original indentation or formatting.
- **Vault-Wide Aggregation**: Use simple `todos` code blocks to pull tasks from anywhere in your vault based on paths or tags.

## 🚀 Performance vs. Features
Most of the work in Fast Todos has been about **taking away functionality**. By removing complex recurrence logic, heavy date parsing libraries, and extensive metadata tracking, we have reduced the memory footprint and ensured that the plugin remains "Fast" regardless of your vault size.

## 🛠 Usage
Create a code block in any note:

```todos
not done
path includes Today
group by filename
```

---
*Created with ❤️ for Obsidian users who value speed and aesthetics.*

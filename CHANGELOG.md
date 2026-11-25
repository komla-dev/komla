# Changelog

## [1.3.0]

### New

- **Links on markers.** `komla mark` takes `--link <url>`, so an agent can put a clickable pull request marker on its workspace card. Clicking the marker on the card or in Overview opens the page, through the SSH host's tunnel for a localhost link.
- **SSH hosts catch up with origin at once.** After a push or land on this computer, connected SSH hosts fetch origin's target branch right away instead of at their next background fetch, and when a host finds that origin has moved, this computer fetches at once too.
- **A project's folders in its settings.** Project settings has a Folders card showing Komla's clone of the project and its worktrees folder, each copyable and openable, so you can tell where a project's files live, even after renaming it.

### Improvements

- The branch pickers are now named "New Branch from…" and "Open Existing Branch…", so it's clearer which one starts a new branch and which opens one that already exists.
- `komla launch --effort` works without `--preset`, picking the level for the agent the launch would start.
- The setup step and Quick Command editors say which shell runs the command, such as PowerShell 7, WSL or the SSH host's shell, and the setup failure toast's button opens the failed step's output.
- When an SSH workspace's repository was renamed and a project here still has the old URL, Komla offers to link its workspaces to that project instead of adding a second one.
- When a project's copy on an SSH host has a different origin URL, the error now names both URLs and the copy's folder.
- Phones can connect after a restart without opening Settings first. Komla keeps retrying remote control and the Tailscale Serve route, including when your computer wakes, and Settings says what failed in the meantime.

### Fixes

- Restarting to install an update on macOS now offers to restart the workspaces that were running.
- A branch rebased after it was pushed no longer shows its pushed commits as behind origin, and an SSH workspace can push it.
- A workspace started from another workspace's branch keeps the project's target branch, instead of comparing against the other branch.
- Creating an SSH workspace no longer fails after the token or password in a project's origin URL changed.
- A photo an agent adds in an SSH workspace shows in the diff, instead of "Binary file changed".
- The pull request item in the status bar hides when `gh` can't read the pull request, instead of showing a grey icon for good.
- Bold text in the terminal no longer mixes in glyphs from a fallback font, most visible on Windows.
- Files excluded in a local repository's `.git/info/exclude` stay excluded in workspaces of the project made from it.
- Adding a project never deletes a folder Komla didn't make. A folder already at the project's path gets the next free name instead.
- Voice transcription works on Windows x64 and Intel Macs.
- A background setup step or Quick Command in PowerShell that fails is now reported as failed.
- The diff of an SSH workspace whose folder is gone from its host shows no changes, instead of an error quoting the command.
- A diff that fails to refresh keeps showing the last one, instead of reporting an app error.
- An SSH workspace no longer makes Komla lag while a build in it writes files nonstop.

## [1.2.2]

### Fixes

- Moving an SSH workspace to the Trash no longer makes Komla sluggish for several seconds while it deletes the workspace's local copy. The copy is set aside at once and removed quietly in the background.

## [1.2.1]

### Fixes

- Komla no longer freezes for several seconds at a time when agents outside a Komla terminal, such as Claude Desktop's, report their status, which was most noticeable with many SSH workspaces.
- Terminals no longer stutter while the "Moved to the Trash" toast with its Undo button is showing.
- A tab keeps showing that Claude Code is working when Claude moves the session to the background mid-turn, instead of going quiet while the agent carries on.
- SSH workspaces from another installation whose files are gone no longer make Komla ask the host about them on every sync.
- When an SSH host can't be reached, such as overnight or while your Mac's screen is locked, Komla waits longer between reconnect attempts instead of retrying every 30 seconds for hours, and reconnects right away when your Mac wakes or unlocks.

## [1.2.0]

### New

- **Scratch workspaces.** Start an agent for a quick one-off, like a throwaway script or trying an idea, without picking a project or making a folder first. New Scratch Workspace is in Quick create and the sidebar's Scratch group, or pick it in the New Workspace dialog's project list to write the prompt and choose the agent before you launch. Its folder is cleaned up when the workspace is deleted for good, unless you choose Keep Folder.
- **File tree actions in the header.** A new button in the file tree's header opens Expand All, Collapse All and Rollback All Changes, so you no longer have to right-click a sliver of empty space to find them.

### Improvements

- Switching workspaces is much snappier with many terminals open. Clicking a workspace highlights it at once, terminals in hidden workspaces no longer redraw in the background, and the occasional second-long freeze when switching is gone.
- Opening, creating or restarting a workspace no longer briefly freezes the window when lots of workspaces are open.
- Stepping onto an SSH workspace after a restart, sleep or dropped connection opens it right away and connects in the background, instead of leaving the previous workspace on screen.
- Workspaces started in the background no longer resize their split panes' terminals twice the first time you open them.
- The workspace card no longer shows a "Connecting…" spinner.
- A workspace started with `komla launch`, from your phone or by an automation, now shows its project in the sidebar even if you'd hidden it, so you no longer have to search for it.
- A workspace you opened from the Working shelf moves back into its group as soon as its agent stops, instead of only once you switch away.
- A file or folder path an agent prints is now a link even without an extension or a trailing slash, as long as it's really there.
- A link to a file that isn't where the agent said, such as a path from a subfolder or a file that has since moved, opens the file it meant when only one matches, or offers up to six to pick from.

### Fixes

- Quitting Komla right after opening a workspace no longer sometimes leaves it running in the background.
- A request to review settings changes or allow a message is no longer cancelled by a stray Enter or Escape while you're typing to an agent. Only the Cancel button cancels it.
- An agent on an SSH host no longer keeps spinning after it finished while the connection was down.
- An SSH workspace launched with a long prompt now starts its agent, instead of appearing without one.
- An SSH workspace's Git status is up to date right after a commit, land or push, including on hosts with many workspaces, instead of showing it a commit ahead.
- After switching environment in the New Workspace dialog, Enter now launches the workspace instead of switching the environment back.
- A workspace moved to the Trash is always stopped first, so the Trash no longer holds workspaces that are still running.
- An SSH workspace that's missing from its host no longer shows "Failed to create SSH workspace" again every time it changes.
- A screenshot dragged from the iOS Simulator into the New Workspace dialog now attaches, instead of failing when you launch because the Simulator had already deleted it.
- A workspace an agent moves to the Trash, for example with `komla trash`, now closes if it's open, instead of staying on screen with nothing running.
- A link to a folder that an agent prints without a trailing slash now opens the folder, instead of failing with a "Couldn't show" error.
- A Trash cleanup script that fails no longer keeps the workspace out of the Trash. The workspace is trashed anyway, and a message shows what the script printed instead of the whole command line.

## [1.1.0]

### New

- **Pop the prompt draft out over other apps.** The prompt draft can float in a window of its own that stays on top of your browser or any other app, so you can write a prompt about what you're looking at without switching back and forth. Its shortcut shows and hides it, and "Put back in Komla" brings the text back.
- **Start a workspace from any app.** Give "New Workspace from any app" keys in Settings > Shortcuts, and pressing them anywhere brings Komla forward with New Workspace open and the prompt ready to type. It ships unbound, since a system-wide shortcut takes those keys from every other app.
- **See the commits your branch is behind by.** The commit graph in the status bar now shows the commits on the target branch that your branch doesn't have yet, above your own. Click one to open its diff in History.

### Improvements

- The globe button lists your dev servers faster, most noticeably in SSH workspaces and when several workspaces share a machine.
- A remote workspace shows its cloud icon from the moment it starts setting up.
- The sidebar always lists workspaces with the tighter compact spacing, so the setting for it is gone.
- The macOS installer now shows a "Drag Komla into Applications" background, with an arrow from the app to the Applications folder.
- A workspace card keeps a small spinner for work still under way, such as running tests, even while a notification badge or a busy agent holds its title row.
- Dragging a workspace or project group near the top or bottom of the sidebar scrolls the list, so you can reach a spot that's out of view without dropping it first.
- When an agent uses `komla send` to type into another terminal, Komla now asks you first, showing the exact text and where it's going. A page-steered agent can no longer run commands in your shell tabs or answer another agent's prompt on its own.
- Launch mode pickers are less crowded: "Dangerously skip permissions" is now called YOLO for Claude Code and Amp, as it already was for other agents. It's still red and passes the same flags.

### Fixes

- Switching to another workspace right after trashing one no longer lags while the trashed workspace's files are deleted.
- Escape closes the file preview while you're typing in the Markdown editor or a note.
- Opening a diff of a file containing Unicode line or paragraph separators no longer pops up a dialog offering to remove them.
- The files list no longer shows files outside the workspace that have since been deleted.
- A status item an agent on an SSH host sets with a localhost link now opens through a tunnel to that host, instead of a page that isn't there on your own computer.
- With more than one Komla attached to the same SSH host, a Done you've seen in one no longer shows as unread in the others.

## [1.0.0]

Komla is a desktop app for running many AI coding agents in parallel, each in its own workspace, with one place to see which of them need you. This is the first release under the Komla name, and it is open source under the MIT License.

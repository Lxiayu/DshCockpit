# Product Philosophy

## Not another Harness UI

DshCockpit is not designed to replace, redesign, or modify the DeepSeek Harness WebUI.

Harness already provides the workspace where users talk to agents, inspect files, write code, and complete tasks.

DshCockpit has a different responsibility:

> **Harness owns the workspace.
> DshCockpit owns the operating layer.**

DshCockpit turns Harness from a terminal-launched tool into a managed desktop Agent runtime.

It adds the capabilities that belong outside the workspace itself:

* Token and context monitoring
* Quick Ask
* Background Tasks
* Cost and usage tracking
* Runtime management
* Session search
* Remote control
* Integrations
* Desktop-level automation

The goal is not to make Harness look different.

The goal is to make Harness feel like a complete desktop application.

---

## Invisible when working. Obvious when needed.

This is the core interaction principle of DshCockpit.

> **Invisible when working. Obvious when needed.**

DshCockpit should stay out of the way while users are working inside Harness.

It should consume as little screen space as possible, avoid changing the native Harness layout, and remain visually quiet during normal conversations.

At the same time, its capabilities should never feel hidden.

A new user should be able to open DshCockpit and quickly understand:

> "This is Harness, but this desktop application also gives me monitoring, automation, runtime control, Quick Ask, cost tracking, and more."

This is why DshCockpit prefers lightweight overlays, edge controls, Peek panels, and progressive disclosure over permanent sidebars and large dashboards.

---

## The Cockpit, not the Settings page

A common mistake in desktop applications is to put every feature inside Settings.

That makes the application technically complete but practically invisible.

DshCockpit follows a different information architecture.

### Always visible

The highest-value, highest-frequency capabilities should remain immediately discoverable:

* Token / Context
* Cockpit
* Quick Ask
* Tasks

### One click away

The Cockpit provides direct access to:

* Usage
* Cost
* Runtime
* Session Search
* Remote
* Automation
* Integrations

### Configuration only

Settings is reserved for configuration:

* API
* Models
* Network
* Updates
* Storage
* Backup
* Shortcuts
* Privacy
* Appearance
* Advanced options

In other words:

> **Settings is not a feature hub.
> Settings is a configuration center.**

---

## Progressive Disclosure

DshCockpit should reveal complexity gradually.

A user should not need to open a large dashboard simply to answer a small question.

For example:

Token status should be visible at a glance.

Clicking it should open a lightweight Peek panel.

Tasks should provide a quick status preview.

The Cockpit should provide the full control surface.

Settings should provide deep configuration.

The preferred interaction hierarchy is:

**Default → Peek → Cockpit → Full configuration**

This allows DshCockpit to remain powerful without becoming visually heavy.

---

## Desktop Agent, not just WebUI

The most important conceptual difference between DshCockpit and a normal WebUI wrapper is that DshCockpit treats the Agent as a desktop service.

An Agent should not be limited to the currently visible conversation.

It can:

* run in the background
* execute scheduled tasks
* remain monitored
* consume resources
* accumulate usage and costs
* receive remote commands
* update its runtime
* continue operating while the main workspace is not being actively used

This leads to an important product principle:

> **Agent ≠ the current window.**

Instead:

> **Agent = a continuously manageable runtime.**

DshCockpit is the layer that makes that runtime visible and controllable.

---

## Zero-invasive UI

DshCockpit deliberately avoids modifying the internal Harness UI.

The WebUI should remain as close to the original Harness experience as possible.

DshCockpit should prefer stable boundaries such as:

* HTTP
* WebSocket
* IPC
* filesystem state
* explicit runtime interfaces

It should avoid unnecessary dependencies on:

* DOM selectors
* CSS class names
* React component internals
* undocumented UI state
* private implementation details

This is not only an engineering preference.

It is a product principle.

> **The user should be able to keep the original Harness experience even as Harness evolves.**

If DeepSeek changes the layout, CSS, component tree, or frontend implementation, DshCockpit should remain as independent as possible.

---

## Compatibility is a product feature

For a desktop shell, compatibility is part of the user experience.

A beautiful UI is not useful if a minor Harness update breaks it.

DshCockpit therefore treats isolation and compatibility as first-class product requirements.

The shell should depend on stable runtime contracts, not fragile frontend internals.

This allows DshCockpit to evolve independently while preserving the original Harness workspace.

The long-term goal is simple:

> **Harness can change.
> DshCockpit should remain useful.**

---

## Minimal surface, maximum capability

DshCockpit should never try to display everything at once.

The design target is:

> **Many capabilities, very little visual weight.**

The default interface should feel almost invisible.

The expanded interface should feel powerful.

The relationship should be:

```text
Small surface
     ↓
Clear state
     ↓
Fast action
     ↓
Deep control when needed
```

This is why DshCockpit favors:

* edge controls
* overlays
* Peek panels
* progressive disclosure
* command-style interactions
* lightweight status indicators

over:

* permanent sidebars
* large dashboards
* duplicated workspaces
* dense configuration screens

---

## The product in one sentence

> **DshCockpit is a desktop control plane for DeepSeek Harness.**

It does not try to be a better Harness WebUI.

It makes Harness feel like a complete desktop Agent platform.

Or, more simply:

> **Harness owns the workspace.
> DshCockpit owns the operating layer.**

> **Invisible when working.
> Obvious when needed.**

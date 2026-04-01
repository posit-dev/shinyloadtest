import { updateUrlState } from "./navigation-state"
import type { ProcessedRun } from "./types"

export { getUrlState, updateUrlState } from "./navigation-state"

const VALID_SECTIONS = new Set([
  "sessions",
  "session-duration",
  "waterfall",
  "latency",
  "event-duration",
  "event-concurrency",
])

export function navigateToSection(
  sectionId: string,
  pushState?: boolean,
): void {
  if (!VALID_SECTIONS.has(sectionId)) return
  document.querySelectorAll(".nav-link").forEach((l) => {
    l.classList.remove("active")
    l.setAttribute("aria-selected", "false")
    l.setAttribute("tabindex", "-1")
  })
  const link = document.querySelector(
    '.nav-link[data-section="' + sectionId + '"]',
  )
  if (link) {
    link.classList.add("active")
    link.setAttribute("aria-selected", "true")
    link.setAttribute("tabindex", "0")
  }
  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"))
  const section = document.getElementById(sectionId)
  if (section) section.classList.add("active")
  if (pushState !== false) updateUrlState({ section: sectionId, tab: null })
}

export function navigateToSubTab(
  sectionEl: HTMLElement,
  tabId: string,
  pushState?: boolean,
): void {
  if (!sectionEl) return
  const tab = sectionEl.querySelector(
    '.sub-tab[data-subtab="' + CSS.escape(tabId) + '"]',
  )
  if (!tab) return
  sectionEl.querySelectorAll(".sub-tab").forEach((t) => {
    t.classList.remove("active")
    t.setAttribute("aria-selected", "false")
    ;(t as HTMLElement).tabIndex = -1
  })
  tab.classList.add("active")
  tab.setAttribute("aria-selected", "true")
  ;(tab as HTMLElement).tabIndex = 0
  sectionEl
    .querySelectorAll(".sub-content")
    .forEach((c) => c.classList.remove("active"))
  const content = document.getElementById(tabId)
  if (content) content.classList.add("active")
  if (pushState !== false) updateUrlState({ tab: tabId })
}

function setupTablistKeyboard(
  tablistEl: Element,
  tabSelector: string,
  onActivate: (tab: HTMLElement) => void,
  vertical = false,
): void {
  tablistEl.addEventListener("keydown", (e) => {
    const event = e as KeyboardEvent
    const tabs = [
      ...tablistEl.querySelectorAll<HTMLElement>(tabSelector),
    ].filter((t) => t.style.display !== "none")
    const current = tabs.indexOf(event.target as HTMLElement)
    if (current < 0) return

    const prev = vertical ? "ArrowUp" : "ArrowLeft"
    const next = vertical ? "ArrowDown" : "ArrowRight"
    let target: HTMLElement | null = null

    switch (event.key) {
      case next:
        target = tabs[(current + 1) % tabs.length]
        break
      case prev:
        target = tabs[(current - 1 + tabs.length) % tabs.length]
        break
      case "Home":
        target = tabs[0]
        break
      case "End":
        target = tabs[tabs.length - 1]
        break
      default:
        return
    }

    if (target) {
      event.preventDefault()
      target.focus()
      onActivate(target)
    }
  })
}

export function setupNavigation(): void {
  const sidebar = document.getElementById("sidebar")!
  const menuToggle = document.getElementById("menu-toggle")!
  const sidebarOverlay = document.getElementById("sidebar-overlay")!

  function openSidebar() {
    sidebar.classList.add("open")
    sidebarOverlay.classList.add("visible")
    menuToggle.classList.add("hidden")
    menuToggle.setAttribute("aria-expanded", "true")
  }
  function closeSidebar() {
    sidebar.classList.remove("open")
    sidebarOverlay.classList.remove("visible")
    menuToggle.classList.remove("hidden")
    menuToggle.setAttribute("aria-expanded", "false")
  }

  menuToggle.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) {
      closeSidebar()
    } else {
      openSidebar()
    }
  })
  sidebarOverlay.addEventListener("click", closeSidebar)

  // Set initial tabindex: active tab is 0, others are -1
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.setAttribute(
      "tabindex",
      link.classList.contains("active") ? "0" : "-1",
    )
    link.addEventListener("click", (e) => {
      e.preventDefault()
      navigateToSection((link as HTMLElement).dataset.section ?? "")
      closeSidebar()
    })
  })

  const navList = document.querySelector(".nav-list")!
  setupTablistKeyboard(
    navList,
    ".nav-link",
    (tab) => {
      navigateToSection(tab.dataset.section ?? "")
      closeSidebar()
    },
    true,
  )

  document.querySelectorAll(".sub-tabs").forEach((tabGroup) => {
    // Set initial tabindex for sub-tabs
    tabGroup.querySelectorAll(".sub-tab").forEach((tab) => {
      ;(tab as HTMLElement).tabIndex = tab.classList.contains("active") ? 0 : -1
      tab.addEventListener("click", () => {
        navigateToSubTab(
          tab.closest(".section") as HTMLElement,
          (tab as HTMLElement).dataset.subtab ?? "",
        )
      })
    })

    setupTablistKeyboard(tabGroup, ".sub-tab", (tab) => {
      navigateToSubTab(
        tab.closest(".section") as HTMLElement,
        tab.dataset.subtab ?? "",
      )
    })
  })
}

export function setupRunSelector(
  runs: ProcessedRun[],
  onRunChange: (idx: number) => void,
): void {
  const runSelect = document.getElementById(
    "run-select",
  ) as HTMLSelectElement | null
  if (!runSelect) return

  runs.forEach((run, i) => {
    const opt = document.createElement("option")
    opt.value = String(i)
    opt.textContent = run.name
    runSelect.appendChild(opt)
  })

  runSelect.addEventListener("change", () => {
    const idx = Number(runSelect.value)
    updateUrlState({ run: idx > 0 ? idx : null })
    onRunChange(idx)
  })

  if (runs.length <= 1) {
    const sidebarRunSelect = document.getElementById("sidebar-run-select")
    if (sidebarRunSelect) sidebarRunSelect.style.display = "none"
  }
}

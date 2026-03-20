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
  document
    .querySelectorAll(".nav-link")
    .forEach((l) => l.classList.remove("active"))
  const link = document.querySelector(
    '.nav-link[data-section="' + sectionId + '"]',
  )
  if (link) link.classList.add("active")
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
  sectionEl
    .querySelectorAll(".sub-tab")
    .forEach((t) => t.classList.remove("active"))
  tab.classList.add("active")
  sectionEl
    .querySelectorAll(".sub-content")
    .forEach((c) => c.classList.remove("active"))
  const content = document.getElementById(tabId)
  if (content) content.classList.add("active")
  if (pushState !== false) updateUrlState({ tab: tabId })
}

export function setupNavigation(): void {
  const sidebar = document.getElementById("sidebar")!
  const menuToggle = document.getElementById("menu-toggle")!
  const sidebarOverlay = document.getElementById("sidebar-overlay")!

  function openSidebar() {
    sidebar.classList.add("open")
    sidebarOverlay.classList.add("visible")
  }
  function closeSidebar() {
    sidebar.classList.remove("open")
    sidebarOverlay.classList.remove("visible")
  }

  menuToggle.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) {
      closeSidebar()
    } else {
      openSidebar()
    }
  })
  sidebarOverlay.addEventListener("click", closeSidebar)

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault()
      navigateToSection((link as HTMLElement).dataset.section ?? "")
      closeSidebar()
    })
  })

  document.querySelectorAll(".sub-tabs").forEach((tabGroup) => {
    tabGroup.querySelectorAll(".sub-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        navigateToSubTab(
          tab.closest(".section") as HTMLElement,
          (tab as HTMLElement).dataset.subtab ?? "",
        )
      })
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

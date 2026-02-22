function copyToClipboard(text: string, btn: HTMLElement) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const copyIcon = btn.querySelector(".copy-icon") as HTMLElement
      const checkIcon = btn.querySelector(".check-icon") as HTMLElement
      const label = btn.querySelector(".copy-label") as HTMLElement | null

      if (copyIcon) {
        copyIcon.classList.add("hidden")
      }
      if (checkIcon) {
        checkIcon.classList.remove("hidden")
      }
      if (label) {
        label.textContent = "Copied!"
      }

      setTimeout(() => {
        if (copyIcon) {
          copyIcon.classList.remove("hidden")
        }
        if (checkIcon) {
          checkIcon.classList.add("hidden")
        }
        if (label) {
          label.textContent = "Copy"
        }
      }, 2000)
    })
    .catch(() => {
      const label = btn.querySelector(".copy-label") as HTMLElement | null
      if (label) {
        label.textContent = "Copy failed"
        setTimeout(() => {
          label.textContent = "Copy"
        }, 2000)
      }
    })
}

function attachHeroCopyButton(): void {
  const heroButton = document.getElementById("hero-copy-btn")
  if (!heroButton) {
    return
  }

  heroButton.addEventListener("click", () => {
    const textEl = heroButton.querySelector(".hero-copy-text") as HTMLElement
    const copyIcon = heroButton.querySelector(".copy-icon") as HTMLElement
    const checkIcon = heroButton.querySelector(".check-icon") as HTMLElement

    navigator.clipboard
      .writeText("npx reclaw")
      .then(() => {
        if (textEl) {
          textEl.textContent = "Copied!"
        }
        if (copyIcon) {
          copyIcon.classList.add("hidden")
        }
        if (checkIcon) {
          checkIcon.classList.remove("hidden")
        }

        setTimeout(() => {
          if (textEl) {
            textEl.textContent = "npx reclaw"
          }
          if (copyIcon) {
            copyIcon.classList.remove("hidden")
          }
          if (checkIcon) {
            checkIcon.classList.add("hidden")
          }
        }, 2000)
      })
      .catch(() => {
        if (textEl) {
          textEl.textContent = "Copy failed"
          setTimeout(() => {
            textEl.textContent = "npx reclaw"
          }, 2000)
        }
      })
  })
}

function attachTerminalCopyButton(): void {
  const terminalButton = document.getElementById("terminal-copy-btn")
  if (!terminalButton) {
    return
  }

  terminalButton.addEventListener("click", () => {
    copyToClipboard("npx reclaw", terminalButton)
  })
}

export function attachCopyButtons(): void {
  attachHeroCopyButton()
  attachTerminalCopyButton()
}

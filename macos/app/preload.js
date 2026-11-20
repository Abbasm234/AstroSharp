'use strict'

// Runs in the app window (isolated from the page). It only watches two things
// Shiny already exposes in the DOM and reports them to the main process:
//   - <html class="shiny-busy"> while R is computing, so the Mac is kept awake
//     during long jobs;
//   - the "disconnected" overlay Shiny adds when its connection to R drops, so
//     the window can reconnect by itself.

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const root = document.documentElement
  let lastBusy = null
  const reportBusy = () => {
    const busy = root.classList.contains('shiny-busy')
    if (busy !== lastBusy) {
      lastBusy = busy
      ipcRenderer.send('astrosharp:busy', busy)
    }
  }
  new MutationObserver(reportBusy).observe(root, { attributes: true, attributeFilter: ['class'] })
  reportBusy()

  let reported = false
  const checkDisconnected = () => {
    if (!reported && document.getElementById('shiny-disconnected-overlay')) {
      reported = true
      ipcRenderer.send('astrosharp:disconnected')
    }
  }
  if (document.body) {
    new MutationObserver(checkDisconnected).observe(document.body, { childList: true })
  }
})

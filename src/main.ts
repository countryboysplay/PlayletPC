import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initDesktop } from './lib/desktop'

// Install the desktop transport/storage/window bindings before the first render, so
// the app never issues a request over the browser fetch fallback by accident.
await initDesktop()

const target = document.getElementById('app')
if (!target) throw new Error('Mount target #app is missing from index.html')

export default mount(App, { target })

// Central store: talks to the server, holds the last snapshot, and lets panels
// subscribe to changes.

const api = {
    async get(path) {
        const res = await fetch(path)
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `GET ${path} failed`)
        return body
    },
    async post(path, data) {
        const res = await fetch(path, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify(data || {})
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `POST ${path} failed`)
        return body
    }
}

const listeners = new Set()
const eventListeners = new Set()

const store = {
    api,
    state: null,
    accounts: [],
    accountTotal: 0,
    commands: null,
    catalog: [],
    series: {points: []},
    actingAs: null,
    panel: "setup",

    onChange(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
    },
    onEvent(fn) {
        eventListeners.add(fn)
        return () => eventListeners.delete(fn)
    },
    emitChange() {
        for (const fn of listeners) fn(store)
    },

    byPanel(panel) {
        return store.catalog.filter(a => a.panel === panel)
    },

    action(id) {
        return store.catalog.find(a => a.id === id)
    },

    /** The account whose address signs user-level actions. */
    acting() {
        return store.actingAs || (store.accounts[0] && store.accounts[0].address) || null
    },

    actingAccount() {
        const a = store.acting()
        return store.accounts.find(x => x.address.toLowerCase() === String(a).toLowerCase()) || null
    },

    async loadCommands() {
        const res = await api.get("/api/commands")
        store.commands = res.lifecycle
        store.catalog = res.catalog
    },

    async refreshAccounts(limit = 30) {
        try {
            const res = await api.get(`/api/accounts?limit=${limit}`)
            store.accounts = res.accounts
            store.accountTotal = res.total
            if (!store.actingAs && res.accounts.length) store.actingAs = res.accounts[0].address
        } catch (err) {
            store.accounts = []
        }
    },

    async refreshSeries() {
        try {
            store.series = await api.get("/api/series")
        } catch (err) {
            store.series = {points: []}
        }
    },

    async refresh({accounts = true, series = true} = {}) {
        store.state = await api.get("/api/state")
        if (accounts && store.state.chain.up) await store.refreshAccounts()
        if (series) await store.refreshSeries()
        store.emitChange()
        return store.state
    }
}

/** Server-sent events: child process output, transactions, progress. */
export function connectEvents() {
    const source = new EventSource("/api/events")
    source.onmessage = ev => {
        let payload
        try {
            payload = JSON.parse(ev.data)
        } catch (err) {
            return
        }
        for (const fn of eventListeners) fn(payload)
    }
    source.onerror = () => {
        /* EventSource reconnects on its own */
    }
    return source
}

export default store
export {api}

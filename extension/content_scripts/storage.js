const storage = {
  KEY_PREFIX: 'iondv',
  STRATEGY_KEY_PARAM: 'strategy_param',
  STRATEGY_KEY_RESULTS: 'strategy_result',
  SIGNALS_KEY_PREFIX: 'signals'
}

// Every entry of this extension lives under one prefix. A caller passes the short name and never builds a key,
// so a read, a write and a delete can not disagree about the prefix.
storage.storageKey = (storageKey) => `${storage.KEY_PREFIX}_${storageKey}`

// null   -> every entry of this extension, keyed by its full storage key
// string -> the value, or null when the entry does not exist
// array  -> { fullKey: value } for the entries that exist
storage.getKey = async (storageKey) => {
  if (storageKey === null) {
    const allData = await new Promise(resolve => chrome.storage.local.get(null, resolve))
    const storageData = {}
    Object.keys(allData)
      .filter(key => key.startsWith(`${storage.KEY_PREFIX}_`))
      .forEach(key => storageData[key] = allData[key])
    return storageData
  }
  const isMultiple = Array.isArray(storageKey)
  const keys = (isMultiple ? storageKey : [storageKey]).map(storage.storageKey)
  const values = await new Promise(resolve => chrome.storage.local.get(keys, resolve))
  if (!isMultiple)
    return Object.hasOwn(values, keys[0]) ? values[keys[0]] : null
  const result = {}
  keys.forEach(key => {
    if (Object.hasOwn(values, key))
      result[key] = values[key]
  })
  return result
}

storage.setKeys = async (storageKey, value) => {
  const storageData = {}
  storageData[storage.storageKey(storageKey)] = value
  return new Promise(resolve => {
    chrome.storage.local.set(storageData, () => {
      resolve()
    })
  })
}

storage.removeKey = async (storageKey) => {
  const keys = (Array.isArray(storageKey) ? storageKey : [storageKey]).map(storage.storageKey)
  return new Promise(resolve => {
    chrome.storage.local.remove(keys, () => {
      resolve()
    })
  })
}

// Removes every entry of this extension and returns the removed storage keys
storage.clearAll = async () => {
  const allStorageKey = Object.keys(await storage.getKey(null))
  if (!allStorageKey.length)
    return []
  return new Promise(resolve => {
    chrome.storage.local.remove(allStorageKey, () => {
      resolve(allStorageKey)
    })
  })
}

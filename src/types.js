// 数据契约(对应 docs §4.3)。纯 JSDoc 类型,不引入 TS 工具链。

/**
 * @typedef {Object} Meta
 * @property {number} schemaVersion
 * @property {{tabs:number, groups:number}} counts
 * @property {number} sizeBytes
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} IndexEntry
 * @property {string} id
 * @property {'tab'|'group'} type
 * @property {string} name
 * @property {string} [url]
 * @property {string|null} [iconKey]
 * @property {string} [color]
 * @property {number} [childCount]
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} TabSnapshot
 * @property {string} id
 * @property {'tab'} type
 * @property {string} name
 * @property {string} url
 * @property {string|null} iconKey
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} GroupSnapshot
 * @property {string} id
 * @property {'group'} type
 * @property {string} name
 * @property {string} color
 * @property {TabSnapshot[]} children
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {TabSnapshot|GroupSnapshot} Snapshot
 */

/**
 * @typedef {Object} UiState
 * @property {'current'|'records'} activeTab
 * @property {Record<string, boolean>} expanded
 * @property {number} [scroll]
 */

export const SCHEMA_VERSION = 1;
export const FORMAT_NAME = "tabgroup-recorder-export";

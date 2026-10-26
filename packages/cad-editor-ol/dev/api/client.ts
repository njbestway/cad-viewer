/**
 * Backend API entry point for the GIS fork.
 *
 * Drawing CRUD / versioning / permission calls will be added here once the
 * backend contract is fixed. Components should import from this module instead
 * of calling `fetch` directly, so the base URL and auth headers stay in one
 * place.
 */

/** Where the backend lives. Swap for a full URL when deploying cross-origin. */
export const cadApiBaseUrl = '/api'

/** Minimal drawing metadata returned by the backend. */
export interface CadDrawingSummary {
  id: string
  name: string
  /** Latest version number; versions themselves are immutable. */
  version: number
  updatedAt: string
}

/** Send a JSON request to the backend and parse the JSON response. */
export async function cadApiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${cadApiBaseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    }
  })
  if (!response.ok) {
    throw new Error(`CAD API ${path} failed with status ${response.status}`)
  }
  return (await response.json()) as T
}

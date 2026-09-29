/**
 * Epicurrents dcmjs shim.
 *
 * `dcmjs` ships no type declarations. Declaring the bare module would type the whole library as
 * `any`, which hides mistakes at exactly the call sites that matter — a promise passed to
 * `readFile` in place of a buffer type-checks and then fails at run time — so only the slice this
 * package uses is declared, with real signatures.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

declare module 'dcmjs' {
    /** A parsed DICOM file, keyed by tag and not yet naturalized. */
    export type DicomDict = {
        dict: Record<string, unknown>
        meta: Record<string, unknown>
    }
    export const data: {
        DicomMessage: {
            /**
             * Parse a DICOM part 10 file.
             * @param buffer - The entire file. This is synchronous and does not accept a promise.
             */
            readFile (buffer: ArrayBuffer, options?: Record<string, unknown>): DicomDict
        }
        DicomMetaDictionary: {
            /**
             * Convert a tag-keyed dictionary into one keyed by attribute keyword.
             * @param dict - The `dict` property of a parsed file.
             */
            naturalizeDataset (dict: Record<string, unknown>): Record<string, unknown>
        }
    }
}

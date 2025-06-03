/**
 * Epicurrents file loader tests.
 * Due to the high level of integration, tests must be run sequentially.
 * This file describes the testing sequence and runs the appropriate tests.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SETTINGS } from '@epicurrents/core'
import DicomReader from '../src/dicom/DicomReader'

describe('Epicurrents DICOM file loader tests', () => {
    test('Create and instance of file reader', () => {
        const loader = new DicomReader(SETTINGS)
        expect(loader).toBeDefined()
    })
})

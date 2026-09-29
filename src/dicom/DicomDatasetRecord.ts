/**
 * DICOM dataset record class to store parsed DICOM dataset information.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader } from '@epicurrents/core'
import { convertDicomDateTime, signalPropertiesFromWaveform } from '#util'
import type { DicomDataset } from '#types'
import type { AnnotationEventTemplate } from '@epicurrents/core/types'

export default class DicomDatasetRecord extends GenericBiosignalHeader {
    protected _physicalSignals: number[][]

    /**
     * @param dataset - The parsed DICOM dataset to describe.
     * @param physicalSignals - Decoded signals in their SI units, one array per channel (optional).
     * @param events - Annotations belonging to the signals (optional).
     */
    constructor (
        dataset: DicomDataset,
        physicalSignals = [] as number[][],
        events = [] as AnnotationEventTemplate[],
    ) {
        // There should be only one waveform sequence in a DICOM biosignal recording.
        const waveform = dataset.WaveformSequence[0]
        // A multiplex group interleaves the samples of its channels, so one sample of every channel
        // is the smallest unit the data divides into.
        super(
            'dicom',
            dataset.StudyID || '',
            dataset.PatientID || '',
            waveform.NumberOfWaveformSamples,
            1/waveform.SamplingFrequency,
            (waveform.WaveformBitsAllocated/8)*waveform.NumberOfWaveformChannels,
            waveform.NumberOfWaveformChannels,
            signalPropertiesFromWaveform(waveform),
            convertDicomDateTime(dataset.AcquisitionDateTime),
            false, // A DICOM multiplex group is continuous.
            events,
        )
        this._physicalSignals = physicalSignals
    }

    /** Decoded signals in their SI units, one array per channel, empty for a header-only record. */
    get physicalSignals () {
        return this._physicalSignals
    }
}

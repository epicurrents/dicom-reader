/**
 * DICOM dataset record class to store parsed DICOM dataset information.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader } from '@epicurrents/core'
import { convertDicomDateTime, extractSignalModality } from '#util'
import type { DicomChannelDefinitionSequence, DicomDataset } from '#types'
import type { AnnotationTemplate } from '@epicurrents/core/dist/types'

export default class DicomDatasetRecord extends GenericBiosignalHeader {
    protected _physicalSignals = [] as number[][]
    protected _rawSignals: Int16Array[]

    constructor (
        dataset: DicomDataset,
        rawSignals = [] as Int16Array[],
        physicalSignals = [] as number[][],
        annotations = [] as AnnotationTemplate[],
    ) {
        // There should be only one waveform sequence in the DICOM header.
        const ws = dataset.WaveformSequence[0]
        // Multiplexed DICOM signals contain channel samples in a consecutive order. The parsed DICOM file already
        // contains the extracted signals so we can basically ignore this.
        const nDataUnits = ws.NumberOfWaveformSamples
        const dataUnitLength = 1/ws.SamplingFrequency
        const dataUnitSize = (ws.WaveformBitsAllocated/8)*ws.NumberOfWaveformChannels
        super(
            'dicom',
            dataset.StudyID,
            dataset.PatientID,
            nDataUnits,
            dataUnitLength,
            dataUnitSize,
            ws.NumberOfWaveformChannels,
            ws.ChannelDefinitionSequence.map((s: DicomChannelDefinitionSequence) => {
                return {
                    label: s.ChannelLabel,
                    modality: extractSignalModality(s),
                    name: s.ChannelLabel,
                    physicalUnit: s.ChannelSensitivityUnitsSequence[0].CodeValue || '',
                    prefiltering: {
                        bandreject: [],
                        highpass: s.FilterHighFrequency || 0,
                        lowpass: s.FilterLowFrequency || 0,
                        notch: s.NotchFilterFrequency || 0,
                    },
                    sampleCount: ws.NumberOfWaveformSamples,
                    samplingRate: ws.SamplingFrequency,
                    sensitivity: 0, // Has a different meaning in DICOM, so we set it to 0.
                    sensor: 'Unknown',
                }
            }),
            convertDicomDateTime(dataset.AcquisitionDateTime),
            false, // DICOM files are always continuous.
            annotations,
        )
        this._rawSignals = rawSignals
        this._physicalSignals = physicalSignals
    }

}

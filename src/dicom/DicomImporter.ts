/**
 * Epicurrents DICOM importer.
 * @package    epicurrents/dicom-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericStudyImporter } from '@epicurrents/core'
import type {
    BiosignalHeaderRecord,
    ConfigReadUrl,
    SignalStudyImporter,
    StudyContextFile,
    StudyFileContext,
} from '@epicurrents/core/types'
import { channelPhysicalUnit, headerToBiosignalHeader, signalUnitScale } from '#util'
import type { DicomDataset } from '#types'
import DicomWorkerSubstitute from '#dicom/DicomWorkerSubstitute'
import { Log } from 'scoped-event-log'
import * as dcmjs from 'dcmjs'
import InlineDicomWorker from '../workers/dicom.worker.ts?worker&inline'

const SCOPE = 'DicomImporter'

export default class DicomImporter extends GenericStudyImporter implements SignalStudyImporter {
    protected _useSAB: boolean

    constructor (useSAB = false) {
        const fileTypeAssocs = [
            {
                accept: {
                    'application/octet-stream': ['.dcm'],
                },
                description: 'DICOM',
            },
        ]
        super(SCOPE, [], fileTypeAssocs)
        this._useSAB = useSAB
        this._getWorkerSubstitute = () => new DicomWorkerSubstitute()
    }

    /**
     * Describe the dataset's channels and header on the study.
     *
     * The dataset's samples are dropped once the header has been built: the importer has parsed the
     * whole file to reach the metadata, and keeping a second copy of the data alive until the study
     * closes doubles the recording's footprint for nothing — the worker parses the file itself.
     */
    protected _readAndStoreMetadata (dataset: DicomDataset) {
        if (!this._study) {
            Log.error('No study available to insert channel info into.', SCOPE)
            return
        }
        const waveform = dataset.WaveformSequence?.[0]
        if (!waveform) {
            Log.error('No waveform sequence found in the DICOM dataset.', SCOPE)
            return
        }
        // The digital range the samples span, which the equipment may state and otherwise follows
        // from the allocated width and the signedness of the sample interpretation.
        const bits = waveform.WaveformBitsAllocated || 16
        const unsigned = waveform.WaveformSampleInterpretation?.startsWith('U') ?? false
        const channels = []
        for (const channel of waveform.ChannelDefinitionSequence || []) {
            // The calibration attributes are present together, for a channel whose samples carry
            // defined units, and absent together for one whose samples do not.
            const sensitivity = (channel.ChannelSensitivity ?? 1)*(channel.ChannelSensitivityCorrectionFactor ?? 1)
            const baseline = channel.ChannelBaseline ?? 0
            // Samples are cached in the SI unit of their quantity, so the bounds are stated in it too.
            const scale = signalUnitScale(channel)
            const digitalMax = channel.ChannelMaximumValue ?? (unsigned ? 2**bits - 1 : 2**(bits - 1) - 1)
            const digitalMin = channel.ChannelMinimumValue ?? (unsigned ? 0 : -(2**(bits - 1)))
            channels.push({
                channelNumber: channel.WaveformChannelNumber || 0,
                filter: {
                    bandreject: [],
                    // DICOM names the cutoffs after the edges of the pass band, so the *low*
                    // frequency is the high-pass cutoff and the *high* frequency the low-pass one.
                    highpass: channel.FilterLowFrequency || 0,
                    lowpass: channel.FilterHighFrequency || 0,
                    notch: channel.NotchFilterFrequency || 0,
                },
                label: channel.ChannelLabel || '',
                name: channel.ChannelLabel || '',
                physicalMax: (digitalMax*sensitivity + baseline)*scale,
                physicalMin: (digitalMin*sensitivity + baseline)*scale,
                sampleCount: waveform.NumberOfWaveformSamples || 0,
                samplesPerRecord: 1,
                samplingRate: waveform.SamplingFrequency || 0,
                scale: 0, // Scale here is always 0 as we convert the source signals into SI units.
                sensitivity: 0, // DICOM channel sensitivity is not the same as EC source channel sensitivity.
                signal: new Float32Array(),
                transducer: '', // Unknown.
                unit: channelPhysicalUnit(channel),
            })
        }
        this._study.meta = {
            channels,
            header: headerToBiosignalHeader(dataset),
            formatHeader: null, // The DICOM dataset is not serializable so we won't return it in case this is a worker.
        }
        // Built above, so this releases the samples without losing anything the study needs.
        waveform.WaveformData = []
        this._study.format = 'dicom'
        this._study.modality = 'signal'
    }

    getFileTypeWorker (override?: string): Worker | null {
        if (override === 'substitute') {
            return this._getWorkerSubstitute()
        }
        const getWorkerOverride = this._workerOverrides.get(override || 'dicom')
        const worker = getWorkerOverride ? getWorkerOverride() : new InlineDicomWorker()
        if (!getWorkerOverride) {
            Log.registerWorker(worker)
        }
        return worker
    }

    async importFile (source: File | StudyFileContext, config?: ConfigReadUrl) {
        const file = (source as StudyFileContext).file || source as File
        Log.debug(`Loading DICOM from file ${file.webkitRelativePath || file.name}.`, SCOPE)
        const studyFile = {
            file: file,
            format: 'dicom',
            mime: config?.mime || file.type || null,
            name: config?.name || file.name || '',
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || URL.createObjectURL(file),
        } as StudyContextFile
        try {
            const dicom = dcmjs.data.DicomMessage.readFile(await file.arrayBuffer())
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            this._readAndStoreMetadata(dataset)
        } catch (e: unknown) {
            Log.error(`DICOM header parsing error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        // Added only once the file has parsed, so a study does not list a file it could not read.
        this._study.files.push(studyFile)
        return studyFile
    }

    async importUrl (source: string | StudyFileContext, config?: ConfigReadUrl) {
        const url = (source as StudyFileContext).url || source as string
        Log.debug(`Loading DICOM from url ${url}.`, SCOPE)
        const studyFile = {
            file: null,
            format: 'dicom',
            mime: config?.mime || null,
            name: config?.name || '',
            partial: false,
            range: [],
            role: 'data',
            modality: 'signal',
            url: config?.url || url,
        } as StudyContextFile
        try {
            // We need to get the whole file to read the header.
            const arrayBuffer = await this._fetchArrayBuffer(url, { authHeader: config?.authHeader })
            const dicom = dcmjs.data.DicomMessage.readFile(arrayBuffer)
            const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict) as DicomDataset
            this._readAndStoreMetadata(dataset)
        } catch (e: unknown) {
            Log.error(`DICOM header parsing error: ${(e as Error).message}.`, SCOPE, e as Error)
            return null
        }
        this._study.files.push(studyFile)
        return studyFile
    }

    // Nothing to await, but the importer interface declares the method asynchronous.
    // eslint-disable-next-line @typescript-eslint/require-await
    async readHeader (_source: ArrayBuffer): Promise<BiosignalHeaderRecord | null> {
        // DICOM has no fixed-size header to read ahead of the data: the attributes are a tag stream
        // the samples are embedded in, so there is no prefix that yields a header on its own.
        return null
    }
}

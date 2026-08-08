// ========================================
// Video Editor Module - Public API
// ========================================

// Types
export type {
    VideoEditorProject,
    VideoClip,
    BgmClip,
    ClipAttachment,
    ClipTransition,
    ClipMetadata,
    EditorConfig,
    TimelineState,
    ComputedClip,
    SaveEditorProjectRequest,
    RenderRequest,
    RenderStatus
} from './types/editor.types'

// Utils
export {
    calculateTimelineDuration,
    computeClipPositions,
    framesToTime,
    timeToFrames,
    generateClipId,
    createDefaultProject,
    createProjectFromPanels,
    type PanelData
} from './utils'

export {
    migrateProjectData,
    validateProjectData
} from './utils/migration'

// Components
export { VideoEditorStage } from './components/VideoEditorStage'
export { TransitionPicker } from './components/TransitionPicker'

// Hooks
export { useEditorState } from './hooks/useEditorState'
export { useEditorActions } from './hooks/useEditorActions'

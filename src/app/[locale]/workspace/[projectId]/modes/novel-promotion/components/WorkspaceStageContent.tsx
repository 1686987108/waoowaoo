'use client'

import ConfigStage from './ConfigStage'
import ScriptStage from './ScriptStage'
import StoryboardStage from './StoryboardStage'
import VideoStageRoute from './VideoStageRoute'
import VoiceStageRoute from './VoiceStageRoute'
import VideoEditorStageRoute from './EditorStageRoute'

interface WorkspaceStageContentProps {
  currentStage: string
  onStageChange?: (stage: string) => void
}

export default function WorkspaceStageContent({
  currentStage,
  onStageChange
}: WorkspaceStageContentProps) {
  return (
    <div key={currentStage} className="animate-page-enter">
      {currentStage === 'config' && <ConfigStage />}

      {(currentStage === 'script' || currentStage === 'assets') && <ScriptStage />}

      {currentStage === 'storyboard' && <StoryboardStage />}

      {currentStage === 'videos' && <VideoStageRoute />}

      {currentStage === 'voice' && <VoiceStageRoute />}

      {currentStage === 'editor' && (
        <VideoEditorStageRoute
          onBack={() => onStageChange?.('videos')}
        />
      )}
    </div>
  )
}

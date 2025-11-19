import { useEffect } from "react";
import {
  useShareStatus,
  useShareError,
  useShareAlias,
  useViewStatus,
  useViewError,
  useViewStream,
  useSetShareAlias,
  useHandleShareScreen,
  useHandleViewStream,
  useLocalShareStream,
} from "../store/channelStoreHelpers";
import { useChannelStore } from "../store/channelStore";
import { ScreenHeader } from "../components/ScreenHeader";
import { BroadcastPlayer } from "../components/BroadcastPlayer";
import { ShareScreenCard } from "../components/ShareScreenCard";
import { ViewStreamCard } from "../components/ViewStreamCard";

type ChannelPeerScreenProps = {
  hostKey: string;
  onBack: () => void;
};

export function ChannelPeerScreen({ hostKey, onBack }: ChannelPeerScreenProps) {
  const shareStatus = useShareStatus();
  const shareError = useShareError();
  const shareAlias = useShareAlias();
  const viewStatus = useViewStatus();
  const viewError = useViewError();
  const viewStream = useViewStream();
  const localShareStream = useLocalShareStream();
  const setShareAlias = useSetShareAlias();
  const handleShareScreen = useHandleShareScreen();
  const handleViewStream = useHandleViewStream();

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      // Use getState to avoid dependency issues with function references
      const { stopShareSession, stopViewSession } = useChannelStore.getState();
      stopShareSession();
      stopViewSession();
    };
  }, []); // Empty deps - only run on unmount

  const activeStream = viewStream || localShareStream;
  const activeLabel = viewStream ? "Host Stream" : localShareStream ? "You" : null;
  const activeTitle = viewStream ? "Live Stream" : localShareStream ? "Screen Share" : null;

  return (
    <div className="app">
      <div className="page page-full-width">
        <div className="card">
          <ScreenHeader
            label="Channel host key"
            value={hostKey}
            backButtonLabel="Back to channels"
            onBack={onBack}
          />

          <BroadcastPlayer
            stream={activeStream}
            peerLabel={activeLabel}
            peerScreenTitle={activeTitle}
          />

          <div className="options-grid">
            <ShareScreenCard
              shareStatus={shareStatus}
              shareError={shareError}
              shareAlias={shareAlias}
              onAliasChange={setShareAlias}
              onShareClick={() => handleShareScreen(hostKey)}
            />
            <ViewStreamCard
              viewStatus={viewStatus}
              viewError={viewError}
              stream={null}
              onViewClick={() => handleViewStream(hostKey)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

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
  useStopShareSession,
  useStopViewSession,
} from "../store/channelStoreHelpers";
import { ScreenHeader } from "../components/ScreenHeader";
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
  const setShareAlias = useSetShareAlias();
  const handleShareScreen = useHandleShareScreen();
  const handleViewStream = useHandleViewStream();
  const stopShareSession = useStopShareSession();
  const stopViewSession = useStopViewSession();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopShareSession();
      stopViewSession();
    };
  }, [stopShareSession, stopViewSession]);

  return (
    <div className="app">
      <div className="page">
        <div className="card">
          <ScreenHeader
            label="Channel host key"
            value={hostKey}
            backButtonLabel="Back to channels"
            onBack={onBack}
          />

          <section className="section">
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
                stream={viewStream}
                onViewClick={() => handleViewStream(hostKey)}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

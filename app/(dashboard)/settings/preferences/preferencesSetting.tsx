import AutoAssignOnTickeActionSetting from "./autoAssignOnTicketActionSetting";
import ConfettiSetting from "./confettiSetting";
import NextTicketPreviewSetting from "./nextTicketPreviewSetting";

const PreferencesSetting = () => {
  return (
    <div className="space-y-6">
      <AutoAssignOnTickeActionSetting />
      <ConfettiSetting />
      <NextTicketPreviewSetting />
    </div>
  );
};

export default PreferencesSetting;

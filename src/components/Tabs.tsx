import { useState, ReactNode } from "react";

interface TabsProps {
  tabs: {
    [key: string]: ReactNode;
  };
}

export function Tabs({ tabs }: TabsProps) {
  const [activeTab, setActiveTab] = useState<string>(Object.keys(tabs)[0]);

  return (
    <div className="tabs-container">
      <div className="tabs-header">
        {Object.keys(tabs).map((tabName) => (
          <button
            key={tabName}
            className={`tab-button ${activeTab === tabName ? "active" : ""}`}
            onClick={() => setActiveTab(tabName)}
          >
            {tabName}
          </button>
        ))}
      </div>
      <div className="tabs-content">
        {tabs[activeTab]}
      </div>
    </div>
  );
}


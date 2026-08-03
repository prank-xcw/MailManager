// 广告插槽配置类型（本地配置，由用户在「广告设置」面板中填写）
export type AdSlotConfig = {
  enabled: boolean;
  title: string;
  description: string;
  image_url: string;
  image_alt: string;
  primary_action: {
    label: string;
    href: string;
  };
};

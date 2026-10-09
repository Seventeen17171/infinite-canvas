import {
    AppstoreOutlined,
    ArrowLeftOutlined,
    ArrowRightOutlined,
    FolderOpenOutlined,
    LogoutOutlined,
    MoonOutlined,
    PictureOutlined,
    PlusOutlined,
    ReloadOutlined,
    SearchOutlined,
    SettingOutlined,
    SunOutlined,
    TeamOutlined,
    UserOutlined,
} from "@ant-design/icons";
import type { CSSProperties } from "react";

const icons = {
    projects: FolderOpenOutlined,
    canvas: AppstoreOutlined,
    assets: PictureOutlined,
    back: ArrowLeftOutlined,
    enter: ArrowRightOutlined,
    logout: LogoutOutlined,
    moon: MoonOutlined,
    sun: SunOutlined,
    plus: PlusOutlined,
    reload: ReloadOutlined,
    search: SearchOutlined,
    settings: SettingOutlined,
    team: TeamOutlined,
    user: UserOutlined,
};
export function ProjectIcon({ name, style }: { name: keyof typeof icons; style?: CSSProperties }) {
    const Icon = icons[name];
    return <Icon aria-hidden style={style} />;
}

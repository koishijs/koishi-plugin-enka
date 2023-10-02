export enum EnkaAgent {
  ENKA = 'https://enka.network',
}

export enum EnkaDataAgent {
  NYAN = 'https://koi.nyan.zone/enka',
  GITHUB = 'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store'
}

export interface EnkaApiData {
  playerInfo: PlayerInfo
  avatarInfoList: any[]
  ttl: number
  uid: string
}

export interface PlayerInfo {
  nickname: string
  level: number
  signature: string
  worldLevel: number
  nameCardId: number
  finishAchievementNum: number
  towerFloorIndex: number
  towerLevelIndex: number
  showAvatarInfoList: ShowAvatarInfoList[]
}

export interface ShowAvatarInfoList {
  avatarId: number
  level: number
  costumeId?: number
}

export interface EnkaCharacterData {
  [key: `${string}`]: CharacterData
}

export interface CharacterData {
  Element: string
  Consts: string[]
  SkillOrder: number[]
  Skills: Record<`${number}`, string>
  ProudMap: Record<`${number}`, number>
  NameTextMapHash: number
  SideIconName: string
  QualityType: string
  WeaponType: string
  Costumes: Record<`${number}`, Costumes>
}

export interface Costumes {
  sideIconName: string
  icon: string
  art: string
  avatarId: number
}

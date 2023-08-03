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

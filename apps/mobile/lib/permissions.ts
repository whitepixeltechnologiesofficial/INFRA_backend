import * as Contacts from 'expo-contacts';
import * as Notifications from 'expo-notifications';
import * as Audio from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { syncContactsFromDevice } from './contact-sync';

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';

export async function checkContactsState(): Promise<PermissionState> {
  const { status } = await Contacts.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  if (status === 'undetermined') return 'unknown';
  return 'denied';
}

export async function requestContactsPermission(): Promise<PermissionState> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status === 'granted') {
    syncContactsFromDevice();
    return 'granted';
  }
  return 'denied';
}

export async function checkNotificationsState(): Promise<PermissionState> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  if (status === 'undetermined') return 'unknown';
  return 'denied';
}

export async function requestNotificationsPermission(): Promise<PermissionState> {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted' ? 'granted' : 'denied';
}

export async function checkMicrophoneState(): Promise<PermissionState> {
  const { status } = await Audio.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  if (status === 'undetermined') return 'unknown';
  return 'denied';
}

export async function requestMicrophonePermission(): Promise<PermissionState> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted' ? 'granted' : 'denied';
}

export async function checkCameraState(): Promise<PermissionState> {
  const { status } = await ImagePicker.getCameraPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  if (status === 'undetermined') return 'unknown';
  return 'denied';
}

export async function requestCameraPermission(): Promise<PermissionState> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  return status === 'granted' ? 'granted' : 'denied';
}

export async function checkPhotosState(): Promise<PermissionState> {
  const res = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (res.status === 'granted' || (res as any).accessPrivileges === 'limited') return 'granted';
  if (res.status === 'denied') return 'denied';
  if (res.status === 'undetermined') return 'unknown';
  return 'denied';
}

export async function requestPhotosPermission(): Promise<PermissionState> {
  const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (res.status === 'granted' || (res as any).accessPrivileges === 'limited') return 'granted';
  return 'denied';
}

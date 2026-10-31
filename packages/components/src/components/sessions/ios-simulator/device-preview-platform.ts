import { createContext, useContext } from 'react';
export const DevicePreviewPlatformContext = createContext<'ios' | 'android'>('ios');
export const useDevicePreviewPlatform = () => useContext(DevicePreviewPlatformContext);

import { createContext, useContext } from 'react';

/** Lets an error notice send the customer to a step ("Edit the brief") without every step passing goTo down. */
const MakerNav = createContext({ goTo: null });
export const MakerNavProvider = MakerNav.Provider;
export const useMakerNav = () => useContext(MakerNav);

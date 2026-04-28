// Pulled from Bard/Terman neurobook ODE examples page.
export const COMMON_MODELS = [
    {
        "id": "hodgkin-huxley-equations",
        "label": "Hodgkin huxley equations",
        "fileName": "hodgkin-huxley-equations.ode",
        "source": "#  Hodgkin huxley equations\ninit v=-65  m=.05  h=0.6  n=.317\npar i0=0\npar vna=50  vk=-77  vl=-54.4  gna=120  gk=36  gl=0.3  c=1  phi=1\npar ip=0 pon=50 poff=150\nis(t)=ip*heav(t-pon)*heav(poff-t)\nam(v)=phi*.1*(v+40)/(1-exp(-(v+40)/10))\nbm(v)=phi*4*exp(-(v+65)/18)\nah(v)=phi*.07*exp(-(v+65)/20)\nbh(v)=phi*1/(1+exp(-(v+35)/10))\nan(v)=phi*.01*(v+55)/(1-exp(-(v+55)/10))\nbn(v)=phi*.125*exp(-(v+65)/80)\nv'=(I0+is(t) - gna*h*(v-vna)*m^3-gk*(v-vk)*n^4-gl*(v-vl)-gsyn*s*(v-vsyn))/c\nm'=am(v)*(1-m)-bm(v)*m\nh'=ah(v)*(1-h)-bh(v)*h\nn'=an(v)*(1-n)-bn(v)*n\ns'=sinf(v)*(1-s)-s/tausyn\n# track the currents\nsinf(v)=alpha/(1+exp(-v/vshp))\npar alpha=2,vshp=5,tausyn=20,gsyn=0,vsyn=0\naux ina=gna*(v-vna)*h*m^3\naux ik=gk*(v-vk)*n^4\naux il=gl*(v-vl)\n# track the stimulus\naux stim=is(t)\n@ bound=10000\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "hh-equivalent-potentials",
        "label": "HH equivalent potentials",
        "fileName": "hh-equivalent-potentials.ode",
        "source": "# HH equivalent potentials\ninit v=-65  vm=-65,vn=-65,vh=-65\npar i0, vna=50  vk=-77  vl=-54.4  gna=120  gk=36  gl=0.3  c=1  phi=1\npar eps=.1\nam(v)=phi*.1*(v+40)/(1-exp(-(v+40)/10))\nbm(v)=phi*4*exp(-(v+65)/18)\nah(v)=phi*.07*exp(-(v+65)/20)\nbh(v)=phi*1/(1+exp(-(v+35)/10))\nan(v)=phi*.01*(v+55)/(1-exp(-(v+55)/10))\nbn(v)=phi*.125*exp(-(v+65)/80)\nminf(v)=am(v)/(am(v)+bm(v))\nninf(v)=an(v)/(an(v)+bn(v))\nhinf(v)=ah(v)/(ah(v)+bh(v))\nkm(v)=am(v)+bm(v)\nkn(v)=an(v)+bn(v)\nkh(v)=ah(v)+bh(v)\nmp(v)=(minf(v+eps)-minf(v-eps))/(2*eps)\nnp(v)=(ninf(v+eps)-ninf(v-eps))/(2*eps)\nhp(v)=(hinf(v+eps)-hinf(v-eps))/(2*eps)\nv'=(I0 - gna*hinf(vh)*(v-vna)*minf(vm)^3-gk*(v-vk)*ninf(vn)^4-gl*(v-vl))/c\nvm'=km(v)*(minf(v)-minf(vm))/mp(vm)\nvn'=kn(v)*(ninf(v)-ninf(vn))/np(vn)\nvh'=kh(v)*(hinf(v)-hinf(vh))/hp(vh)\naux n=ninf(vn)\naux h=hinf(vh)\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "reduced-hh-equations-using-the-rinzel-re",
        "label": "reduced HH equations using the rinzel reduction and n",
        "fileName": "reduced-hh-equations-using-the-rinzel-re.ode",
        "source": "#  reduced HH equations using the rinzel reduction and n\n#  as the variable\ninit v=-65 n=.4\npar i0=0\npar vna=50  vk=-77  vl=-54.4  gna=120  gk=36  gl=0.3  c=1  phi=1\npar ip=0 pon=50 poff=150\nis(t)=ip*heav(t-pon)*heav(poff-t)\nam(v)=phi*.1*(v+40)/(1-exp(-(v+40)/10))\nbm(v)=phi*4*exp(-(v+65)/18)\nah(v)=phi*.07*exp(-(v+65)/20)\nbh(v)=phi*1/(1+exp(-(v+35)/10))\nan(v)=phi*.01*(v+55)/(1-exp(-(v+55)/10))\nbn(v)=phi*.125*exp(-(v+65)/80)\nv'=(I0+is(t) - gna*h*(v-vna)*m^3-gk*(v-vk)*n^4-gl*(v-vl))/c\nm=am(v)/(am(v)+bm(v))\n#h'=ah(v)*(1-h)-bh(v)*h\nn'=an(v)*(1-n)-bn(v)*n\nh=h0-n\npar h0=.8\n@ bound=10000\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "morris-lecar-model",
        "label": "Morris-Lecar model",
        "fileName": "morris-lecar-model.ode",
        "source": "# Morris-Lecar model\ndv/dt = ( I - gca*minf(V)*(V-Vca)-gk*w*(V-VK)-gl*(V-Vl)+s(t))/c\ndw/dt = phi*(winf(V)-w)/tauw(V)\nv(0)=-16\nw(0)=0.014915\nminf(v)=.5*(1+tanh((v-v1)/v2))\nwinf(v)=.5*(1+tanh((v-v3)/v4))\ntauw(v)=1/cosh((v-v3)/(2*v4))\nparam vk=-84,vl=-60,vca=120\nparam i=0,gk=8,gl=2,c=20\nparam v1=-1.2,v2=18\n# Uncomment the ones you like!!\npar1-3 v3=2,v4=30,phi=.04,gca=4.4\nset hopf {v3=2,v4=30,phi=.04,gca=4.4}\nset snic  {v3=12,v4=17.4,phi=.06666667,gca=4}\nset homo {v3=12,v4=17.4,phi=.23,gca=4}\n#par4-6 v3=12,v4=17.4,phi=.06666667,gca=4\n#par7-8 v3=12,v4=17.4,phi=.23,gca=4\nparam s1=0,s2=0,t1=50,t2=55,t3=500,t4=550\n# double pulse stimulus\ns(t)=s1*heav(t-t1)*heav(t2-t)+s2*heav(t-t3)*heav(t4-t)\n@ total=150,dt=.25,xlo=-75,xhi=75,ylo=-.25,yhi=.5,xp=v,yp=w\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "butera-and-smith-model-using-nap",
        "label": "butera and smith model using NaP",
        "fileName": "butera-and-smith-model-using-nap.ode",
        "source": "# butera and smith model using NaP\npar cm=21,i=0\nxinf(v,vt,sig)=1/(1+exp((v-vt)/sig))\ntaux(v,vt,sig,tau)=tau/cosh((v-vt)/(2*sig))\n# leak\nil=gl*(v-el)\npar gl=2.8,el=-65\n# fast sodium --  h=1-n\nminf(v)=xinf(v,-34,-5)\nina=gna*minf(v)^3*(1-n)*(v-ena)\npar gna=28,ena=50\n# delayed rectifier\nninf(v)=xinf(v,-29,-4)\ntaun(v)=taux(v,-29,-4,10)\nik=gk*n^4*(v-ek)\npar gk=11.2,ek=-85\n# NaP\nmninf(v)=xinf(v,-40,-6)\nhinf(v)=xinf(v,-48,6)\ntauh(v)=taux(v,-48,6,taubar)\npar gnap=2.8,taubar=10000\ninap=gnap*mninf(v)*h*(v-ena)\nv' = (i-il-ina-ik-inap)/cm\nn'=(ninf(v)-n)/taun(v)\nh'=(hinf(v)-h)/tauh(v)\n@ total=40000,dt=1,meth=cvode,maxstor=100000\n@ tol=1e-8,atol=1e-8\n@ xlo=0,xhi=40000,ylo=-80,yhi=20\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "l-type-calcium-current-with-calcium-depe",
        "label": "L-type calcium current with calcium-dependent inactivation",
        "fileName": "l-type-calcium-current-with-calcium-depe.ode",
        "source": "# L-type calcium current with calcium-dependent inactivation\n# Poirazi P, Brannon T, Mel BW (2003a)\n# Arithmetic of subthreshold synaptic summation in a model CA1 pyramidal cell.\n# Neuron 37:977-987\n# adjusted beta slightly from .028 to .01\n# from ModelDB\n!faraday=96520\n!rgas=8.3134\n!temp=273.15+celsius\nh=ki/(ki+ca)\nxi=v*faraday*2/(rgas*1000*temp)\ncfedrive=.002*faraday*xi*(ca-cao*exp(-xi))/(1-exp(-xi))\nm=alpm(v)/(alpm(v)+betm(v))\nical=pcal*m*h*cfedrive\npar ki=.001,celsius=25,cao=2,pcal=2,cainf=1e-4,taur=200\ninit ca=1e-4,v=-65\nalpm(v) = 0.055*(-27.01 - v)/(exp((-27.01-v)/3.8) - 1)\nbetm(v) =0.94*exp((-63.01-v)/17)\n# migliore model:\n# alpm(v) = 15.69*(-1.0*v+81.5)/(exp((-1.0*v+81.5)/10.0)-1.0)\n# betm(v) = 0.29*exp(-v/10.86)\nv'=-gl*(v-el)-ical+i0\nca'=-ical*beta-(ca-cainf)/taur\npar beta=.01,i0=0,el=-70,gl=.05\naux ica=ical\n@ total=1000,meth=qualrk,tol=1e-8,atol=1e-8,dt=.25\n@ xp=v,yp=ca,xlo=-80,xhi=-10,ylo=0,yhi=2\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "t-type-current-with-rebound",
        "label": "T-type current with rebound",
        "fileName": "t-type-current-with-rebound.ode",
        "source": "#  T-type current with rebound\n# Has spikes as well - set gna=gk=0 to just have calcium\n# i=+/-.25 for 25 msec or -2 for rebound + depolarized\n# Huguenard and Mccormick T-type calcium kinetics\n# using CFE with calcium fixed in concentration\n# sodium and potassium channels added for spiking\n#\ni(t)=i0+i1*heav(t-ton)*heav(ton+tdur-t)\n!faraday=96520\n!rgas=8.3134\n!temp=273.15+celsius\nxi=v*faraday*2/(rgas*1000*temp)\ncfedrive=.002*faraday*xi*(cai-cao*exp(-xi))/(1-exp(-xi))\nm=minf(v)\npar el=-65,celsius=25,cao=2,pcat=.15,cai=1e-4\npar gna=8,gk=4,ena=55,ek=-90\nminf(v)=1/(1+exp(-(v+59)/6.2))\nhinf(v)=1/(1+exp((v+83)/4))\n# tauh(v)=if(v<(-82))then(exp((v+469)/66.6))else(28 + exp(-(v+24)/10.5))\ntauh(v)=22.7+.27/(exp((v+48)/4)+exp(-(v+407)/50))\ni_cat=pcat*m*m*h*cfedrive\namna=.091*(v+38)/(1-exp(-(v+38)/5))\nbmna=-.062*(v+38)/(1-exp((v+38)/5))\nahna=.016*exp((-55-v)/15)\nbhna=2.07/(1+exp((17-v)/21))\nmna=amna/(amna+bmna)\nank=.01*(-45-v)/(exp((-45-v)/5)-1)\nbnk=.17*exp((-50-v)/40)\nv'=-gl*(v-el)-i_cat+i(t)-gna*mna^3*hna*(v-ena)-gk*n^4*(v-ek)\nh'=(hinf(v)-h)/tauh(v)\nhna'=ahna*(1-hna)-bhna*hna\nn'=ank*(1-n)-bnk*n\ninit h=.16,v=-76\npar gl=.05,i0=0,i1=0,ton=100,tdur=25\naux icat=i_cat\n@ meth=qualrk,dt=.25,total=500,atol=1e-8,rtol=1e-8\n@ nmesh=100,xp=v,yp=h,xlo=-90,ylo=-.1,xhi=20,yhi=.8,bound=1000\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "connor-stevens-model-of-a-current",
        "label": "Connor-Stevens model of A current",
        "fileName": "connor-stevens-model-of-a-current.ode",
        "source": "# Connor-Stevens model of A current\ni(t)=i0+i1*heav(t-ton)\npar i0,ga=47.7\npar gtotal=67.7\n!gk=gtotal-ga\ninit v=-65\npar ek=-72  ena=55  ea=-75  el=-17\npar gna=120   gl=0.3\npar ms=-5.3  hs=-12  ns=-4.3\npar ap=2  ton=100  i1=0\n# Hodgkin-Huxley with shifts - 3.8 is temperature factor\nam(V)=-.1*(V+35+ms)/(exp(-(V+35+ms)/10)-1)\nbm(V)=4*exp(-(V+60+ms)/18)\nminf(V)=am(V)/(am(V)+bm(V))\ntaum(V)=1/(3.8*(am(V)+bm(V)))\nah(V)=.07*exp(-(V+60+hs)/20)\nbh(V)=1/(1+exp(-(V+30+hs)/10))\nhinf(V)=ah(V)/(ah(V)+bh(V))\ntauh(V)=1/(3.8*(ah(V)+bh(V)))\nan(V)=-.01*(V+50+ns)/(exp(-(V+50+ns)/10)-1)\nbn(V)=.125*exp(-(V+60+ns)/80)\nninf(V)=an(V)/(an(V)+bn(V))\n# Taun is doubled\ntaun(V)=2/(3.8*(an(V)+bn(V)))\n# now the A current\nainf(V)=(.0761*exp((V+94.22)/31.84)/(1+exp((V+1.17)/28.93)))^(.3333)\ntaua(V)=.3632+1.158/(1+exp((V+55.96)/20.12))\nbinf(V)=1/(1+exp((V+53.3)/14.54))^4\ntaub(V)=1.24+2.678/(1+exp((V+50)/16.027))\n# Finally the equations...\nv'=-gl*(v-el)-gna*(v-ena)*h*m*m*m-gk*(v-ek)*n*n*n*n-ga*(v-ea)*b*a*a*a+i(t)\nM'=(minf(v)-m)/taum(v)\nH'=(hinf(v)-h)/tauh(v)\nN'=(ninf(v)-n)/taun(v)\nA'=(ainf(v)-a)/taua(v)\nB'=(binf(v)-b)/taub(v)\n@ total=200,xhi=200,ylo=-70,yhi=20\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "inward-rectifier-with-potassium-pump",
        "label": "inward rectifier with potassium pump",
        "fileName": "inward-rectifier-with-potassium-pump.ode",
        "source": "# inward rectifier with potassium pump\nv'=-gl*(v-el)-ikir\nek=90*log10(kout)\nikir=gk/(1+exp((v-vth)/vs))*(v-ek)\npar gk=.8\npar vth=-85,vs=5,el=-60,gl=0.05\ninit v=-63\npar beta=0.04,tau=1000\ninit kout=.1\nkout'=(ikir*beta-(kout-.1))/tau\naux vk=ek\n@ total=2000,meth=qualrk,dt=.5,tol=1e-8,atol=1e-8\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "destexe-pare-model",
        "label": "Destexe \\& Pare model",
        "fileName": "destexe-pare-model.ode",
        "source": "# Destexe \\& Pare model\n#\n# J. Neurophys 1999\n# sodium\nvtrap(x,y)=x/(exp(x/y)-1)\nam(v)=.32*vtrap(-(v-vt-13),4)\npar i=0,gkm=2\n# shifted to acct for threshold\nnum vt=-58,vs=-10\nbm(v)=.28*vtrap(v-vt-40,5)\nah(v)=.128*exp(-(v-vt-vs-17)/18)\nbh(v)=4/(1+exp(-(v-vt-vs-40)/5))\nina(v,m,h)=gna*m^3*h*(v-ena)\npar gna=120,ena=55\n# delayed rectifier\nan(v)=.032*vtrap(-(v-vt-15),5)\nbn(v)=.5*exp(-(v-vt-10)/40)\nikdr(v,n)=gk*n^4*(v-ek)\npar gk=100,ek=-85\n# slow potassium current\nakm(v)=.0001*vtrap(-(v+30),9)\nbkm(v)=.0001*vtrap(v+30,9)\nikm(v,m)=gkm*m*(v-ek)\n#\nv'=(I-gl*(v-el)-ikdr(v,n)-ina(v,m,h)-ikm(v,mk))/cm\nm'=am(v)*(1-m)-bm(v)*m\nh'=ah(v)*(1-h)-bh(v)*h\nn'=an(v)*(1-n)-bn(v)*n\nmk'=akm(v)*(1-mk)-bkm(v)*mk\ninit v=-73.87,m=0,h=1,n=.002,mk=.0075\n# passive stuff\npar gl=.019,el=-65,cm=1\n# numerics stuff\n@ total=1000,dt=.25,meth=qualrk,xhi=1000,maxstor=10000\n@ bound=1000,ylo=-85,yhi=-50\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "sag-inward-rectifier",
        "label": "sag + inward rectifier",
        "fileName": "sag-inward-rectifier.ode",
        "source": "# sag + inward rectifier\n#\npar i=0\npar gl=.025,el=-70\n# sag\n# migliore tau0=46,vm=-80,b=23\n# migliore vt=-81,k=8\n# mccormick tau0=1000,vm=-80,b=13.5\n#\nih=gh*(V-eh)*y\npar gh=0.25,eh=-43\nyinf(v)=1/(1+exp((v-vt)/k))\nty(v)=tau0/cosh((v-vm)/b)\npar k=5.5,vt=-75\npar tau0=1000,vm=-80,b=13.5\n#\n# kir\npar ek=-85,gk=1\nikir=gk*minf(v)*(v-ek)\nminf(v)=1/(1+exp((v-va)/vb))\npar va=-80,vb=5\nv'=i-gl*(v-el)-ih-ikir\ny'=(yinf(v)-y)/ty(v)\ninit v=-68\ninit y=.24\n@ total=1000,meth=qualrk,dt=.25\n@ xp=v,yp=y,xlo=-90,xhi=-40,ylo=0,yhi=0.6\n@ nmesh=100\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "neurobook-model-12",
        "label": "Neurobook Model 12",
        "fileName": "neurobook-model-12.ode",
        "source": "#\n# spiking model plus CAN current\n#\n# sodium\nam(v)=-.32*(v-vt-13)/(exp(-(v-vt-13)/4)-1)\nnum vt=-58,vs=-10\nbm(v)=.28*(v-vt-40)/(exp((v-vt-40)/5)-1)\nah(v)=.128*exp(-(v-vt-vs-17)/18)\nbh(v)=4/(1+exp(-(v-vt-vs-40)/5))\nina(v,m,h)=gna*m^3*h*(v-ena)\npar gna=120,ena=55\n# delayed rectifier\nan(v)=-.032*(v-vt-15)/(exp(-(v-vt-15)/5)-1)\nbn(v)=.5*exp(-(v-vt-10)/40)\nikdr(v,n)=gk*n^4*(v-ek)\npar gk=100,ek=-85\n# voltage\nv'=(I-gl*(v-el)-ikdr(v,n)-ina(v,m,h)-ican)/cm\nm'=am(v)*(1-m)-bm(v)*m\nh'=ah(v)*(1-h)-bh(v)*h\nn'=an(v)*(1-n)-bn(v)*n\n# can dynamics\npar taumc=4000\nican=gcan*mc*(v-ecan)\npar ecan=-20\npar gcan=.05,alpha=.005\nmc'=alpha*ca^2*(1-mc)-mc/taumc\n# pulse function for calcium entry\npuls(t)=heav(t)*heav(wid-t)\n# here is the calcium\nca=puls(t-t1)+puls(t-t2)+puls(t-t3)\npar t1=200,t2=700,t3=1200\npar wid=50\n# initial data\ninit v=-64.97,m=0.003,h=.991,n=.01,mc=0\n# passive\npar gl=.019,el=-65,cm=1,i=0\n# keep track of calcium\naux stim=10*ca-100\n# XPP stuff\n@ total=2000,dt=.05,meth=rk4,xhi=2000,maxstor=100000\n@ bound=1000,ylo=-100,yhi=20\n@ nplot=2,yp2=stim\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "calcium-dependent-potassium-current",
        "label": "Calcium-dependent potassium current",
        "fileName": "calcium-dependent-potassium-current.ode",
        "source": "# Calcium-dependent potassium current\n# uses very simple model of AHP with ca dynamics\n# and high threshold Calc\n# sodium\nam(v)=-.32*(v-vt-13)/(exp(-(v-vt-13)/4)-1)\npar i=0,gkm=2\n# shifted to acct for threshold\nnum vt=-58,vs=-10\nbm(v)=.28*(v-vt-40)/(exp((v-vt-40)/5)-1)\nah(v)=.128*exp(-(v-vt-vs-17)/18)\nbh(v)=4/(1+exp(-(v-vt-vs-40)/5))\nina(v,m,h)=gna*m^3*h*(v-ena)\npar gna=120,ena=55\n# delayed rectifier\nan(v)=-.032*(v-vt-15)/(exp(-(v-vt-15)/5)-1)\nbn(v)=.5*exp(-(v-vt-10)/40)\nikdr(v,n)=gk*n^4*(v-ek)\npar gk=100,ek=-85\n#\n# l-type calcium\nica(v)=gca*(v-eca)/(1+exp(-(v-vlth)/kl))\npar vlth=-5,kl=5,gca=.5,eca=120\nmahp(ca)=ca^2/(kca^2+ca^2)\niahp(ca)=gahp*mahp(ca)*(v-ek)\npar gam=1,tauca=300,kca=2,gahp=1\nv'=(I-gl*(v-el)-ikdr(v,n)-ina(v,m,h)-ica(v)-iahp(ca))/cm\nm'=am(v)*(1-m)-bm(v)*m\nh'=ah(v)*(1-h)-bh(v)*h\nn'=an(v)*(1-n)-bn(v)*n\nca'=-(gam*ica(v)+ca)/tauca\n#\ninit v=-73.87,m=0,h=1,n=.002\n# passive stuff\npar gl=.019,el=-65,cm=1\naux mahpx=mahp(ca)\n# numerics stuff\n@ total=1000,dt=.25,meth=qualrk,xhi=1000,maxstor=10000\n@ bound=1000,ylo=-85,yhi=-50\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "discretization-of-hh-pde",
        "label": "discretization of HH PDE!",
        "fileName": "discretization-of-hh-pde.ode",
        "source": "# discretization of HH PDE!\n#  hhhcable.ode\ninit v[1..150]=-65  m[j]=.05  h[j]=0.6  n[j]=.317\npar L=10,ri=100,d=.1\npar vna=50  vk=-77  vl=-54.4  gna=120  gk=36  gl=0.3  c=1  phi=1\n# two stimulus protocol\npar ip1=0,ip2=0\npar wid=2,t1=10,t2=50\n# smooth step function\nsheav(z)=1/(1+exp(-b*z))\npar b=5\n# local pulse\npar xwid=5\nlpul(t,x)=sheav(xwid-x)*sheav(t)*sheav(wid-t)\nis(t,x)=ip1*lpul(t-t1,x)+ip2*lpul(t-t2,x)\nam(v)=phi*.1*(v+40)/(1-exp(-(v+40)/10))\nbm(v)=phi*4*exp(-(v+65)/18)\nah(v)=phi*.07*exp(-(v+65)/20)\nbh(v)=phi*1/(1+exp(-(v+35)/10))\nan(v)=phi*.01*(v+55)/(1-exp(-(v+55)/10))\nbn(v)=phi*.125*exp(-(v+65)/80)\n# boundaries are zero flux\n!dd=4*d*150*150/(ri*L*L)\nv0=v1\nv151=v150\n%[1..150]\nv[j]'=(is(t,[j]) - gna*h[j]*(v[j]-vna)*m[j]^3-gk*(v[j]-vk)*n[j]^4\\\n     -gl*(v[j]-vl)+(dd)*(v[j+1]-2*v[j]+v[j-1]))/c\nm[j]'=am(v[j])*(1-m[j])-bm(v[j])*m[j]\nh[j]'=ah(v[j])*(1-h[j])-bh(v[j])*h[j]\nn[j]'=an(v[j])*(1-n[j])-bn(v[j])*n[j]\n%\naux stim1=is(t,1)\naux vp50=(is(t,50) - gna*h50*(v50-vna)*m50^3-gk*(v50-vk)*n50^4\\\n     -gl*(v50-vl)+DD*(v51-2*v50 +v49))/c\n@ bound=10000\n@ meth=cvode,bandlo=4,bandup=4\n@ tol=1e-10,atol=1e-10,dt=.05,total=80\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "noisy-lif-without-reset",
        "label": "noisy LIF without reset",
        "fileName": "noisy-lif-without-reset.ode",
        "source": "# noisy LIF without reset\nf(v)=I-V\nwiener w\nV'=f(V)+sig*w\ninit V=0\npar I=0,sig=1\n@ meth=euler,total=200\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "noisy-lif-with-reset",
        "label": "noisy LIF with reset",
        "fileName": "noisy-lif-with-reset.ode",
        "source": "# noisy LIF with reset\nf(v)=I-V\nwiener w\nV'=f(V)+sig*w\ninit V=0\npar Vth=5,vreset=0\npar I=0,sig=1\nglobal 1 v-vth {v=vreset}\n@ meth=euler,total=200\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "first-passage-set-up-to-compute-the-firi",
        "label": "first passage set up to compute the firing times",
        "fileName": "first-passage-set-up-to-compute-the-firi.ode",
        "source": "# first passage set up to compute the firing times\n# this is defined on an interval [0,1]\n# and split up to get the interior value\n#\npar I=-1,sig=1,vreset=-1,vspike=10,a=10\nb=(vreset+a)\nc=(vspike-vreset)\n# ok - here it is\n# u is lower and w is upper interval\n# s lies between 0 and 1\n# u(s=0) = T(-A)\n# u(s=1) = w(s=0)=T(V_reset)\n# w(s=1) = T(V_spike)\n# gotta write it as a system\ndu/dt=up\ndup/dt=-2*b*b/sig-2*f(-a+b*s)*up*b/sig\ndw/dt=wp\ndwp/dt=-2*c*c/sig-2*f(vreset+c*s)*wp*c/sig\nds/dt=1\n# 5 equations - 5 boundary conds\n# du/ds=0 at s=0\nbndry up\n# w=0 at s=1\nbndry w'\n# du/ds(1)=dw/ds(0)\nbndry up'-wp\n# u(1)=w(0)\nbndry u'-w\n# s=t\nbndry s\n# set up some numerics\n@ total=1,dt=.005\n# here is f, dont want to forget  f\nf(x)=x^2+I\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "boundary-value-problem-for-period-of",
        "label": "boundary value problem for period of",
        "fileName": "boundary-value-problem-for-period-of.ode",
        "source": "# boundary value problem for period of\n# quadratic integrate and fire with adaptation\n#\nv'=p*(v^2+i-u)\nu'=p*a*(b*v-u)\np'=0\nb v'-1\nb v-c\nb u-(u'+d)\npar I=1\npar c=-.25,a=.1,b=1,d=.5\ninit p=5.6488\ninit v=-.25,u=1.211\n@ total=1,dt=.005\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "golomb-amitai-model",
        "label": "Golomb Amitai model",
        "fileName": "golomb-amitai-model.ode",
        "source": "# Golomb Amitai model\n# ionic currents\ni_ion(v,h,n,z)=gl*(v-vl)+(gna*minf(v)^3*h+gnap*pinf(v))*(v-vna)+(gk*n^4+gz*z)*(v-vk)\nminf(v)=1/(1+exp(-(v-thetam)/sigmam))\npinf(v)=1/(1+exp(-(v-thetap)/sigmap))\nGAMMAF(VV,theta,sigma)=1.0/(1.0+exp(-(VV-theta)/sigma))\nv'=I-i_ion(v,h,n,z)-gsyn*s*(v-vsyn)\nh'=phi*(GAMMAF(V,thetah,sigmah)-h)/(1.0+7.5*GAMMAF(V,t_tauh,-6.0))\nn'=phi*(GAMMAF(V,thetan,sigman)-n)/(1.0+5.0*GAMMAF(V,t_taun,-15.0))\nz'=(GAMMAF(V,thetaz,sigmaz)-z)/tauZs\ns'=alpha*(1-s)/(1+exp(-(v-vsth)/vshp))-beta*s\n\n# synaptic parameters\np gsyn=0.2\np vsth=-10,vshp=5,alpha=.6,beta=.015,vsyn=0\n\n# kinetic parameters/shapes\np phi=2.7\np thetam=-30.0,sigmam=9.5,thetah=-53.0,sigmah=-7.0\np thetan=-30.0,sigman=10.0,thetap=-40.0,sigmap=5.0\np thetaz=-39.0,sigmaz=5.0,tauZs=75.0\n# ionic parameters\np VNa=55.0,VK=-90.0,VL=-70.0,t_tauh=-40.5,t_taun=-27.0\np gNa=24.0,gK=3.0,gL=0.02,I=0.0\np gNaP=0.07,gZ=.1\n# set gz=0 and gl=.09,vl=-85.5 to compensate\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "the-mccormick-huguenard-channel-models-m",
        "label": "the McCormick-Huguenard channel models -- Mix and match as you like",
        "fileName": "the-mccormick-huguenard-channel-models-m.ode",
        "source": "# the McCormick-Huguenard channel models -- Mix and match as you like\n#\n# UNITS: millivolts, milliseconds, nanofarads, nanoamps, microsiemens\n# moles\n# cell is 29000 micron^2 in area so capacitance is in nanofarads\n# all conductances are in microsiemens and current is in nanofarads.\n#\npar I=0,c=.29\nv'=(I -ina-ik-ileak-ik2-inap-it-iahp-im-ia-ic-il-ih+istep(t))/c\n# the current is a step function with amplitude ip\nistep(t)=ip*heav(t-t_on)*heav(t_off-t)\npar ip=0.0,t_on=100,t_off=200\n# passive leaks\npar gkleak=.007,gnaleak=.0022\nIleak=gkleak*(v-ek)+gnaleak*(v-ena)\n#\naux i_leak=ileak\n#  INA\npar gna=0,Ena=45\nIna=gna*(v-ena)*mna^3*hna\namna=.091*(v+38)/(1-exp(-(v+38)/5))\nbmna=-.062*(v+38)/(1-exp((v+38)/5))\nahna=.016*exp((-55-v)/15)\nbhna=2.07/(1+exp((17-v)/21))\nmna'=amna*(1-mna)-bmna*mna\nhna'=ahna*(1-hna)-bhna*hna\n#\naux i_na=ina\n# Delayed rectifier IK\npar gk=0,Ek=-105\nIk=gk*(v-ek)*nk^4\nank=.01*(-45-v)/(exp((-45-v)/5)-1)\nbnk=.17*exp((-50-v)/40)\nnk'=ank*(1-nk)-bnk*nk\n#\naux i_k=ik\n# INap  same tau as Na but diff activation\npar gnap=0\ninap=gnap*map^3*(v-ena)\nmap'=(1/(1+exp((-49-v)/5))-map)/(amna+bmna)\n#\naux i_nap=inap\n# ia  A-type inactivating potassium current\n#\nia=ga*(v-ek)*(.6*ha1*ma1^4+.4*ha2*ma2^4)\nmainf1=1/(1+exp(-(v+60)/8.5))\nmainf2=1/(1+exp(-(v+36)/20))\ntma=(1/(exp((v+35.82)/19.69)+exp(-(v+79.69)/12.7))+.37)\nma1'=(mainf1-ma1)/tma\nma2'=(mainf2-ma2)/tma\nhainf=1/(1+exp((v+78)/6))\ntadef=1/(exp((v+46.05)/5)+exp(-(v+238.4)/37.45))\ntah1=if(v<(-63))then(tadef)else(19)\ntah2=if(v<(-73))then(tadef)else(60)\nha1'=(hainf-ha1)/tah1\nha2'=(hainf-ha2)/tah2\npar ga=0\naux i_a=ia\n#\n# Ik2  slow potassium current\npar gk2=0,fa=.4,fb=.6\nIk2=gk2*(v-ek)*mk2*(fa*hk2a+fb*hk2b)\nminfk2=1/(1+exp(-(v+43)/17))^4\ntaumk2=1/(exp((v-80.98)/25.64)+exp(-(v+132)/17.953))+9.9\nmk2'=(minfk2-mk2)/taumk2\nhinfk2=1/(1+exp((v+58)/10.6))\ntauhk2a=1/(exp((v-1329)/200)+exp(-(v+129.7)/7.143))+120\ntauhk2b=if((v+70)<0)then(8930)else(tauhk2a)\nhk2a'=(hinfk2-hk2a)/tauhk2a\nhk2b'=(hinfk2-hk2b)/tauhk2b\naux i_k2=ik2\n#\n# IT and calcium dynamics -- transient low threshold\n# permeabilites in 10-6 cm^3/sec\n#\npar Cao=2e-3,temp=23.5,pt=0,camin=50e-9\nnumber faraday=96485,rgas=8.3147,tabs0=273.15\n# CFE stuff\nxi=v*faraday*2/(rgas*(tabs0+temp)*1000)\n# factor of 1000 for millivolts\ncfestuff=2e-3*faraday*xi*(ca-cao*exp(-xi))/(1-exp(-xi))\nIT=pt*ht*mt^2*cfestuff\nmtinf=1/(1+exp(-(v+52)/7.4))\ntaumt=.44+.15/(exp((v+27)/10)+exp(-(v+102)/15))\nhtinf=1/(1+exp((v+80)/5))\ntauht=22.7+.27/(exp((v+48)/4)+exp(-(v+407)/50))\nmt'=(mtinf-mt)/taumt\nht'=(htinf-ht)/tauht\n# il   L-type noninactivating calcium current -- high threshold\npar pl=0\nil=pl*ml^2*cfestuff\naml=1.6/(1+exp(-.072*(V+5)))\nbml=.02*(v-1.31)/(exp((v-1.31)/5.36)-1)\nml'=aml*(1-ml)-bml*ml\naux i_l=il\n# calcium concentration\npar depth=.1,beta=1,area=29000\nca'=-.00518*(it+il)/(area*depth)-beta*(ca-camin)\nca(0)=50e-9\naux i_t=it\n# ic  calcium and voltage dependent fast potassium current\nic=gc*(v-ek)*mc\nac=250000*ca*exp(v/24)\nbc=.1*exp(-v/24)\nmc'=ac*(1-mc)-bc*mc\npar gc=0\naux i_c=ic\n# ih  Sag current -- voltage inactivated inward current\nih=gh*(V-eh)*y\nyinf=1/(1+exp((v+75)/5.5))\nty=3900/(exp(-7.68-.086*v)+exp(5.04+.0701*v))\ny'=(yinf-y)/ty\npar gh=0,eh=-43\n# im   Muscarinic slow voltage gated potassium current\nim=gm*(v-ek)*mm\nmminf=1/(1+exp(-(v+35)/10))\ntaumm=taumm_max/(3.3*(exp((v+35)/20)+exp(-(v+35)/20)))\nmm'=(mminf-mm)/taumm\npar gm=0,taumm_max=1000\naux i_m=im\n# Iahp  Calcium dependent potassium current\nIahp=gahp*(v-ek)*mahp^2\npar gahp=0,bet_ahp=.001,al_ahp=1.2e9\nmahp'=al_ahp*ca*ca*(1-mahp)-bet_ahp*mahp\naux i_ahp=iahp\naux cfe=cfestuff\n#  set up for 1/2 sec simulation in .5 msec increments\n@ total=500,dt=.5,meth=qualrk,atoler=1e-4,toler=1e-5,bound=1000\n@ xhi=500,ylo=-100,yhi=50\ninit v=-70,hna=0.5\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "traub-fast-dynamics-with-two-types-of-ad",
        "label": "Traub fast dynamics with two types of adaptation",
        "fileName": "traub-fast-dynamics-with-two-types-of-ad.ode",
        "source": "# Traub fast dynamics with two types of adaptation\nitrb(v,m,h,n)=gna*h*m^3*(v-ena)+(gk*n^4)*(v-ek)+gl*(v-el)\nv'=-(itrb(v,m,h,n) -i+i_ca+i_ahp+i_m)/c\nm'=am(v)*(1-m)-bm(v)*m\nn'=an(v)*(1-n)-bn(v)*n\nh'=ah(v)*(1-h)-bh(v)*h\nw'=(winf(v)-w)/tw(v)\ns'=alphas*(1-s)/(1+exp(-(v-vthr)/vsshp))-betas*s\n# calcium\nmlinf=1/(1+exp(-(v-vlth)/vshp))\ni_ca=gca*mlinf*(v-eca)\nca'=(-alpha*i_ca-ca/tauca)\n# k-ca\ni_ahp=gahp*(ca/(ca+kd))*(v-ek)\ni_m=gm*w*(v-ek)\n#\n#\nam(v)=.32*(54+v)/(1-exp(-(v+54)/4))\nbm(v)=.28*(v+27)/(exp((v+27)/5)-1)\nah(v)=.128*exp(-(50+v)/18)\nbh(v)=4/(1+exp(-(v+27)/5))\nan(v)=.032*(v+52)/(1-exp(-(v+52)/5))\nbn(v)=.5*exp(-(57+v)/40)\n#\nTW(vs)=tauw/(3.3*EXP((vs-vwt)/20.0)+EXP(-(vs-vwt)/20.0))\nWINF(vs)=1.0/(1.0+EXP(-(vs-vwt)/10.0))\n#\ninit v=42.68904,m=.9935,n=.4645,h=.47785,w=.268,s=.2917,ca=.294\npar ek=-100,ena=50,el=-67,eca=120\npar gl=.2,gk=80,gna=100,gm=0\npar c=1,i=0\npar gahp=0,gca=1,kd=1,alpha=.002,tauca=80,phi=4\npar vshp=2.5,vlth=-25,vsshp=2,vthr=-10\n# reyes set  vlth=-5,vsshp=10\npar betas=.1,alphas=2\npar vwt=-35,tauw=100\naux iahp=i_ahp\naux im=i_m\n@ meth=qualrk,dt=.1,tol=1e-5,total=25.01,xlo=0,xhi=25,ylo=-85,yhi=50\n@ bounds=1000000\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "wang-buszaki-single-cell-fsu",
        "label": "wang buszaki single cell fsu",
        "fileName": "wang-buszaki-single-cell-fsu.ode",
        "source": "# wang buszaki single cell fsu\np i0=0,ip=0,ton=20,toff=60\np phi=5.0\np gL=0.1\np EL=-65.0\np gNa=35.0\np ENa=55.0\np gK=9.0\np EK=-90.0\n#\nV'=-gL*(V-EL)-gNa*(Minf^3)*h*(V-ENa)-gK*(n^4)*(V-EK)+i(t)\nh'=phi*(Hinf-h)/tauH\nn'=phi*(Ninf-n)/tauN\n#\n#\ni(t)=i0+ip*heav(t-ton)*heav(toff-t)\nalpham = 0.1*(V+35.0)/(1.0-exp(-(V+35.0)/10.0))\nbetam  = 4.0*exp(-(V+60.0)/18.0)\nMinf = alpham/(alpham+betam)\n#\nalphah = 0.07*exp(-(V+58.0)/20.0)\nbetah  = 1.0/(1.0+exp(-(V+28.0)/10.0))\nHinf = alphah/(alphah+betah)\ntauH = 1.0/(alphah+betah)\n#\nalphan = 0.01*(V+34.0)/(1.0-exp(-(V+34.0)/10.00))\nbetan  = 0.125*exp(-(V+44.0)/80.0)\nNinf = alphan/(alphan+betan)\ntauN = 1.0/(alphan+betan)\n#\n#\nV(0)=-64\nh(0)=0.78\nn(0)=0.09\n#\n@ XP=T\n@ YP=V\n@ TOTAL=200.0\n@ DT=0.2,bound=10000\n@ METH=qualrk\n@ TOLER=0.00001\n@ XLO=0.0, XHI=200.0, YLO=-90.0, YHI=30.0\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "wang-buszaki-fsu-set-up-in-a-chain-of-50",
        "label": "wang buszaki fsu set up in a chain of 50 neurons",
        "fileName": "wang-buszaki-fsu-set-up-in-a-chain-of-50.ode",
        "source": "# wang buszaki fsu set up in a chain of 50 neurons\np i0=0.5,ip=0,ton=20,toff=60\np phi=5.0\np gL=0.1\np EL=-65.0\np gNa=35.0\np ENa=55.0\np gK=9.0\np EK=-90.0\np gsyn=0.02,esyn=-80\n#\n# WB frequencies are randomly chosen\n#table wr wbfreq.tab\ntable wr % 50 1 50 ran(1)-.5\n@ autoeval=0\ni(x)=i0+i1*wr(x)\npar i1=0.0035\nv0=v1\nv51=v50\ns0=s1\ns51=s50\nV[1..50]'=-gL*(V[j]-EL)-gNa*(Minf(v[j])^3)*h[j]*(V[j]-ENa)-\\\ngK*(n[j]^4)*(V[j]-EK)+i([j])+gsyn*(esyn-v[j])*(s[j-1]+s[j+1])\nh[1..50]'=phi*(alphah(v[j])*(1-h[j])-betah(v[j])*h[j])\nn[1..50]'=phi*(alphan(v[j])*(1-n[j])-betan(v[j])*n[j])\n\ns[1..50]'=ai(v[j])*(1-s[j])-s[j]/taui\n#\nai(v)=ai0/(1+exp(-(v-vst)/vss))\npar ai0=4,taui=6,vst=0,vss=5\n#\nalpham(v) = 0.1*(V+35.0)/(1.0-exp(-(V+35.0)/10.0))\nbetam(v)  = 4.0*exp(-(V+60.0)/18.0)\nMinf(v) = alpham(v)/(alpham(v)+betam(v))\n#\nalphah(v) = 0.07*exp(-(V+58.0)/20.0)\nbetah(v)  = 1.0/(1.0+exp(-(V+28.0)/10.0))\n#\nalphan(v) = 0.01*(V+34.0)/(1.0-exp(-(V+34.0)/10.00))\nbetan(v)  = 0.125*exp(-(V+44.0)/80.0)\n\n#\n#\nV[1..50](0)=-64\nh[1..50](0)=0.78\nn[1..50](0)=0.09\n#\n@ XP=T\n@ YP=V\n@ TOTAL=200\n@ DT=0.2,bound=10000\n@ METH=qualrk\n@ TOLER=0.00001\n@ XLO=0.0, XHI=30.0, YLO=-90.0, YHI=30.0\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "amari-model-with-dynamic-inhibition",
        "label": "Amari model with dynamic inhibition",
        "fileName": "amari-model-with-dynamic-inhibition.ode",
        "source": "# Amari model with dynamic inhibition\n# play with taui\npar sige=8,sigi=6\ntable je % 51 -25 25 exp(-(t/sige)^2)/(sige*sqrt(pi))\ntable ji % 51 -25 25 exp(-(t/sigi)^2)/(sigi*sqrt(pi))\nhue[0..150]=heav(ue[j]-thr)\nspecial ke=conv(even,151,25,je,hue0)\nspecial ki=conv(even,151,25,ji,ui0)\nue[0..150]'=-ue[j]+ae*ke([j])-ki([j])\nui[0..150]'=(-ui[j]+ke([j]))/taui\npar taui=.1\npar thr=.05,ae=1.05\nue[50..75](0)=1\nui[50..75](0)=1\n@ dt=.005,nout=20,total=50\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    },
    {
        "id": "hansel-sompolinsky-model",
        "label": "Hansel & Sompolinsky model",
        "fileName": "hansel-sompolinsky-model.ode",
        "source": "# Hansel & Sompolinsky model\n# simple ring model dynamics\n# u' = -u + J* F(u)\n#  J = A + B cos(x-y)\n#\npar a=2,b=6\ntable cs % 100 0 99 cos(2*pi*t/100)\ntable sn % 100 0 99 sin(2*pi*t/100)\nf(u)=sqrt(max(u-thr,0))\nfu[0..99]=f(c0+c1*cs([j])+d1*sn([j]))\nc0'=-c0+a*sum(0,99)of(shift(fu0,i'))*.01+p0\nc1'=-c1+b*sum(0,99)of(shift(fu0,i')*cs(i'))*.01+p1*cos(w*t)\nd1'=-d1+b*sum(0,99)of(shift(fu0,i')*sn(i'))*.01+p1*sin(w*t)\npar thr=1\npar p0=0,p1=0,w=0\ndone\n",
        "originUrl": "https://sites.pitt.edu/~phase/bard/bardware/neurobook/allodes.html"
    }
];
